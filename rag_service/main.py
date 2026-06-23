"""
RAG microservice — FastAPI + LangChain LCEL + ChromaDB + Gemini 2.5 Flash
Start with: uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

import os
import shutil
from pathlib import Path
from typing import Optional

import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from langchain_chroma import Chroma
from langchain_community.document_loaders import CSVLoader, PyPDFLoader, TextLoader
from langchain_core.documents import Document
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables import RunnablePassthrough
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
if not GOOGLE_API_KEY:
    raise RuntimeError("GOOGLE_API_KEY is not set in .env")

# ── Paths ──────────────────────────────────────────────────────────────────────
CHROMA_DIR = Path("./chroma_db")
UPLOAD_DIR = Path("./uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

# ── LangChain components ───────────────────────────────────────────────────────
embeddings = HuggingFaceEmbeddings(
    model_name="all-MiniLM-L6-v2",
    model_kwargs={"device": "cpu"},
)

llm = ChatGoogleGenerativeAI(
    model="gemini-2.5-flash",
    google_api_key=GOOGLE_API_KEY,
    temperature=0.3,
)

splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)

# ── ChromaDB vector store (persisted) ─────────────────────────────────────────
vectorstore = Chroma(
    collection_name="snap_ai_docs",
    embedding_function=embeddings,
    persist_directory=str(CHROMA_DIR),
)

# ── Per-session chat history (list of HumanMessage / AIMessage) ───────────────
session_histories: dict[str, list] = {}

# ── Prompts ────────────────────────────────────────────────────────────────────
CONDENSE_PROMPT = ChatPromptTemplate.from_messages([
    MessagesPlaceholder(variable_name="chat_history"),
    ("human", "{question}"),
    ("human",
     "Given the conversation above, rewrite the follow-up question as a "
     "standalone question that captures all necessary context."),
])

RAG_PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "You are SNAP AI, a helpful enterprise assistant. "
     "Answer the user's question using ONLY the context provided below. "
     "If the context does not contain the answer, say so honestly.\n\n"
     "Context:\n{context}"),
    MessagesPlaceholder(variable_name="chat_history"),
    ("human", "{question}"),
])

PLAIN_PROMPT = ChatPromptTemplate.from_messages([
    ("system", "You are SNAP AI, a helpful enterprise assistant."),
    MessagesPlaceholder(variable_name="chat_history"),
    ("human", "{question}"),
])

# ── FastAPI app ────────────────────────────────────────────────────────────────
app = FastAPI(title="SNAP AI RAG Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── File loaders ───────────────────────────────────────────────────────────────
ALLOWED_EXTENSIONS = {".pdf", ".csv", ".txt", ".xlsx", ".xls"}


def load_xlsx(path: Path) -> list[Document]:
    xl = pd.ExcelFile(path, engine="openpyxl")
    docs = []
    for sheet in xl.sheet_names:
        df = xl.parse(sheet)
        text = df.to_string(index=False)
        docs.append(Document(page_content=text, metadata={"sheet": sheet}))
    return docs


def load_file(path: Path) -> list[Document]:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return PyPDFLoader(str(path)).load()
    if suffix == ".csv":
        return CSVLoader(str(path)).load()
    if suffix == ".txt":
        return TextLoader(str(path)).load()
    if suffix in (".xlsx", ".xls"):
        return load_xlsx(path)
    raise ValueError(f"Unsupported file type: {suffix}")


# ── Helpers ────────────────────────────────────────────────────────────────────
def get_history(session_id: str) -> list:
    return session_histories.setdefault(session_id, [])


def format_docs(docs: list[Document]) -> str:
    return "\n\n---\n\n".join(d.page_content for d in docs)


async def run_rag_chain(question: str, session_id: str):
    history = get_history(session_id)
    retriever = vectorstore.as_retriever(search_type="similarity", search_kwargs={"k": 5})

    # Step 1 — condense follow-up into standalone question if there's history
    if history:
        condense_chain = CONDENSE_PROMPT | llm | StrOutputParser()
        standalone = await condense_chain.ainvoke({"chat_history": history, "question": question})
    else:
        standalone = question

    # Step 2 — retrieve relevant chunks
    docs = await retriever.ainvoke(standalone)

    # Step 3 — generate answer
    rag_chain = RAG_PROMPT | llm | StrOutputParser()
    answer = await rag_chain.ainvoke({
        "context": format_docs(docs),
        "chat_history": history,
        "question": question,
    })

    # Step 4 — update history (keep last 6 turns = 12 messages)
    history.append(HumanMessage(content=question))
    history.append(AIMessage(content=answer))
    if len(history) > 12:
        session_histories[session_id] = history[-12:]

    sources = list({d.metadata.get("source", "unknown") for d in docs})
    return answer, sources


async def run_plain_chain(question: str, session_id: str):
    history = get_history(session_id)
    plain_chain = PLAIN_PROMPT | llm | StrOutputParser()
    answer = await plain_chain.ainvoke({"chat_history": history, "question": question})

    history.append(HumanMessage(content=question))
    history.append(AIMessage(content=answer))
    if len(history) > 12:
        session_histories[session_id] = history[-12:]

    return answer


# ── Routes ─────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "docs_in_store": vectorstore._collection.count()}


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = "default"


class ChatResponse(BaseModel):
    answer: str
    sources: list[str]
    doc_count: int


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    doc_count = vectorstore._collection.count()

    if doc_count == 0:
        answer = await run_plain_chain(req.message, req.session_id)
        return ChatResponse(answer=answer, sources=[], doc_count=0)

    answer, sources = await run_rag_chain(req.message, req.session_id)
    return ChatResponse(answer=answer, sources=sources, doc_count=doc_count)


@app.post("/upload")
async def upload_document(file: UploadFile = File(...)):
    suffix = Path(file.filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported type '{suffix}'. Allowed: {list(ALLOWED_EXTENSIONS)}",
        )

    dest = UPLOAD_DIR / file.filename
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    try:
        docs = load_file(dest)
        chunks = splitter.split_documents(docs)
        for chunk in chunks:
            chunk.metadata["source"] = file.filename
        vectorstore.add_documents(chunks)
    except Exception as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=str(exc))

    return {
        "filename": file.filename,
        "chunks_indexed": len(chunks),
        "total_docs": vectorstore._collection.count(),
    }


@app.delete("/documents")
def clear_documents():
    global vectorstore
    vectorstore._client.delete_collection("snap_ai_docs")
    vectorstore = Chroma(
        collection_name="snap_ai_docs",
        embedding_function=embeddings,
        persist_directory=str(CHROMA_DIR),
    )
    session_histories.clear()
    return {"status": "cleared"}


@app.delete("/session/{session_id}")
def clear_session(session_id: str):
    session_histories.pop(session_id, None)
    return {"status": "cleared", "session_id": session_id}


@app.get("/documents")
def list_documents():
    count = vectorstore._collection.count()
    if count == 0:
        return {"documents": [], "total_chunks": 0}
    results = vectorstore._collection.get(include=["metadatas"])
    sources = list({m.get("source", "unknown") for m in results["metadatas"]})
    return {"documents": sources, "total_chunks": count}