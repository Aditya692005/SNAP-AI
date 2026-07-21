"""
RAG microservice — FastAPI + LangChain LCEL + Supabase pgvector + Gemini
Start with: uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

import json
import os
import re
import tempfile
import time
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Literal

import markdown
import numpy as np
import pandas as pd
from fpdf import FPDF
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_google_genai.chat_models import ChatGoogleGenerativeAIError
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

import storage as docstore
import supabase_store as store
from handlers import parse_file

load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
if not GOOGLE_API_KEY:
    raise RuntimeError("GOOGLE_API_KEY is not set in .env")

# Model is configurable so you can switch to one with available quota without
# code changes (each Gemini model has its own free-tier daily request limit).
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

# ── Original files ─────────────────────────────────────────────────────────────
# There is no uploads/ directory any more. Original document bytes live in Supabase
# Storage; storage.py fetches them into a disposable local cache on demand. Anywhere
# this file used to build `UPLOAD_DIR / source` it now calls docstore.resolve_source().

# ── LangChain components ───────────────────────────────────────────────────────
embeddings = HuggingFaceEmbeddings(
    model_name="all-MiniLM-L6-v2",
    model_kwargs={"device": "cpu"},
)

# document_chunks.embedding is vector(384); fail fast if the model's output
# length ever changes, since a dim mismatch silently breaks inserts + search.
EMBED_DIM = len(embeddings.embed_query("dimension probe"))
if EMBED_DIM != 384:
    raise RuntimeError(
        f"Embedding model returns {EMBED_DIM} dims but document_chunks expects 384."
    )

# Cross-encoder reranker (P1.4): reorders the hybrid candidate pool by true
# query-chunk relevance. Local + CPU, using the already-installed
# sentence-transformers. Guarded so the service still starts if the model can't
# be downloaded — retrieval then keeps the fused (RRF) order.
RERANKER_MODEL = os.getenv("RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
try:
    from sentence_transformers import CrossEncoder
    reranker = CrossEncoder(RERANKER_MODEL, device="cpu")
except Exception as _rerank_exc:  # noqa: BLE001
    reranker = None
    print(f"[rag] cross-encoder reranker unavailable ({_rerank_exc}); using fused order")

llm = ChatGoogleGenerativeAI(
    model=GEMINI_MODEL,
    google_api_key=GOOGLE_API_KEY,
    temperature=0.2,
)

splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)

# ── Semantic chunking (P2.6) ──────────────────────────────────────────────────
# Dependency-free embedding-boundary chunker: split a block into sentences, embed
# them (reusing MiniLM), and start a new chunk where consecutive-sentence
# similarity drops (a topic shift) or a size cap is hit. Each chunk keeps its
# exact char span within the block (start/end) — reused for citations in P2.7.
# Returns None to signal the caller should fall back to the recursive splitter.
SEMANTIC_MAX_CHARS = 1200        # hard cap so a chunk can't grow unbounded
SEMANTIC_MIN_CHARS = 200         # merge tiny tail chunks into the previous one
SEMANTIC_BREAK_PERCENTILE = 25   # break where similarity is in the lowest quartile
SEMANTIC_INPUT_CAP = 40_000      # above this, use the cheap splitter (bound cost)

_SENT_BOUNDARY = re.compile(r"(?<=[.!?])\s+|\n{2,}")


def _sentence_spans(text: str) -> list[tuple[int, int]]:
    """(start, end) char spans of the sentences in `text`, preserving positions."""
    spans, start = [], 0
    for m in _SENT_BOUNDARY.finditer(text):
        if text[start:m.start()].strip():
            spans.append((start, m.start()))
        start = m.end()
    if text[start:].strip():
        spans.append((start, len(text)))
    return spans


def semantic_split(text: str) -> list[dict] | None:
    """Chunk `text` at semantic boundaries. Each item is
    {text, start, end} with start/end being char offsets INTO `text`.
    None => caller should fall back to the recursive splitter."""
    text = text or ""
    if not text.strip():
        return []
    if len(text) < SEMANTIC_MIN_CHARS or len(text) > SEMANTIC_INPUT_CAP:
        return [{"text": text, "start": 0, "end": len(text)}]
    spans = _sentence_spans(text)
    if len(spans) <= 1:
        return [{"text": text, "start": 0, "end": len(text)}]
    try:
        vecs = np.asarray(embeddings.embed_documents([text[s:e] for s, e in spans]))
    except Exception:
        return None
    norms = np.linalg.norm(vecs, axis=1)
    sims = []
    for i in range(len(spans) - 1):
        denom = norms[i] * norms[i + 1]
        sims.append(float(vecs[i] @ vecs[i + 1] / denom) if denom else 0.0)
    threshold = float(np.percentile(sims, SEMANTIC_BREAK_PERCENTILE)) if sims else 0.0

    chunks: list[dict] = []
    buf_start = spans[0][0]
    for i, (_, cur_end) in enumerate(spans):
        is_last = i == len(spans) - 1
        at_break = i < len(sims) and sims[i] < threshold
        too_big = (cur_end - buf_start) >= SEMANTIC_MAX_CHARS
        if is_last or at_break or too_big:
            if text[buf_start:cur_end].strip():
                chunks.append({"text": text[buf_start:cur_end], "start": buf_start, "end": cur_end})
            if not is_last:
                buf_start = spans[i + 1][0]

    merged: list[dict] = []
    for c in chunks:
        if merged and (c["end"] - c["start"]) < SEMANTIC_MIN_CHARS:
            merged[-1]["end"] = c["end"]
            merged[-1]["text"] = text[merged[-1]["start"]:c["end"]]
        else:
            merged.append(c)
    return merged

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
ALLOWED_EXTENSIONS = {".pdf", ".csv", ".txt", ".xlsx", ".xls", ".docx", ".pptx"}


def excel_engine(path: Path) -> Literal["openpyxl", "xlrd"]:
    """Pick the right pandas/Excel engine: openpyxl reads .xlsx, xlrd reads the
    legacy .xls binary format (openpyxl cannot — it expects a zip-based .xlsx)."""
    return "xlrd" if path.suffix.lower() == ".xls" else "openpyxl"


# ── Supabase-backed indexing (Phase 2) ────────────────────────────────────────
# Tables are stored verbatim in document_tables, but we ALSO embed an LLM-written
# summary of each table so semantic search matches prose ("Q2 revenue by region")
# instead of raw numbers (which embed poorly).
TABLE_SUMMARY_PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "You summarize a data table so it can be found by semantic search. "
     "In 3-6 sentences describe what the table contains: its columns, the "
     "entities and time periods covered, and the most notable figures or trends. "
     "Use concrete numbers taken from the data. Do not invent values."),
    ("human", "Table: {name}\nColumns: {columns}\nRows (JSON sample):\n{rows}"),
])


def summarize_table(table) -> str:
    name = table.table_name or table.sheet_name or "table"
    columns = table.heading_context or (
        ", ".join(map(str, table.rows[0].keys())) if table.rows else ""
    )
    rows_sample = json.dumps(table.rows[:50], ensure_ascii=False)[:6000]
    try:
        chain = TABLE_SUMMARY_PROMPT | llm | StrOutputParser()
        summary = chain.invoke({"name": name, "columns": columns, "rows": rows_sample})
    except Exception:
        # LLM unavailable (quota etc.) — fall back to a deterministic description
        # so indexing still yields a searchable chunk.
        summary = f"Table with columns {columns} and {len(table.rows)} rows."
    return f"[Table: {name}] {summary.strip()}"


def index_document(document_id: str, organization_id: str, path: Path, filename: str) -> dict:
    """Parse a file into Supabase: tables -> document_tables, and text + table
    summaries -> embedded document_chunks. Returns {chunks, tables}."""
    parsed = parse_file(path)

    chunk_texts: list[str] = []
    chunk_metas: list[dict] = []  # parallel: {char_start, char_end, page} per chunk

    # Prose blocks → semantic chunking (falls back to the recursive splitter when
    # semantic_split declines). `page` is the 1-based block index — the page for
    # PDFs, the slide for PPTX, else just a section ordinal. Offsets are within
    # the block, so a citation reads "page N, chars start–end".
    for block_i, block in enumerate(parsed.text_chunks):
        if not (block and block.strip()):
            continue
        page = block_i + 1
        sem = semantic_split(block)
        if sem is None:
            for c in splitter.split_text(block):
                if c.strip():
                    chunk_texts.append(c)
                    chunk_metas.append({"page": page})  # offsets unknown for fallback
        else:
            for c in sem:
                chunk_texts.append(c["text"])
                chunk_metas.append({"char_start": c["start"], "char_end": c["end"], "page": page})

    # Table summaries → short generated text (not a verbatim source span, so no
    # offsets); the recursive splitter is fine.
    for table in parsed.tables:
        store.insert_document_table(document_id, table)
        summary = summarize_table(table)
        if summary and summary.strip():
            for c in splitter.split_text(summary):
                if c.strip():
                    chunk_texts.append(c)
                    chunk_metas.append({})

    if chunk_texts:
        vectors = embeddings.embed_documents(chunk_texts)
        store.insert_document_chunks(
            document_id,
            chunk_texts,
            vectors,
            organization_id=organization_id,
            doc_version=store.get_document_version(document_id),
            source=filename,
            metas=chunk_metas,
        )

    return {"chunks": len(chunk_texts), "tables": len(parsed.tables)}


@app.post("/index")
async def index_endpoint(
    file: UploadFile = File(...),
    document_id: str = Form(...),
    organization_id: str = Form(...),
):
    """Phase 2 ingestion. The backend creates the documents row (with org + user), puts
    the original bytes in Supabase Storage, then posts them here with the document_id to
    embed into Supabase.

    We parse from a TEMP file and throw it away. The bytes arrive in the request, so
    there's nothing to fetch — and the durable copy is already in the bucket, so keeping
    one here would just be a second, quietly diverging original."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided.")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported type '{suffix}'. Allowed: {sorted(ALLOWED_EXTENSIONS)}",
        )

    with tempfile.TemporaryDirectory() as tmp:
        # Keep the real name: some parsers dispatch on the extension.
        dest = Path(tmp) / Path(file.filename).name
        dest.write_bytes(await file.read())

        # Idempotent re-index: clear any existing chunks/tables for this document.
        store.delete_document_data(document_id)
        try:
            result = index_document(document_id, organization_id, dest, file.filename)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Indexing failed: {exc}")

    return {"document_id": document_id, "filename": file.filename, **result}


# ── Helpers ────────────────────────────────────────────────────────────────────
def get_history(session_id: str) -> list:
    return session_histories.setdefault(session_id, [])


# Max characters of context fed to the model when summarizing a whole document.
# Gemini 2.5 Flash has a very large context window; this keeps requests fast/cheap.
MAX_CONTEXT_CHARS = 300_000  # generous: whole-table dumps for focused tabular docs
# For an UNFOCUSED query, include full table data for at most this many of the
# semantically-matched documents (relevance order), so a broad question doesn't
# dump every document's tables into the context.
MAX_TABLE_DOCS = 3

# Phrases that signal the user wants the whole document, not just similar snippets.
WHOLE_DOC_KEYWORDS = (
    "summary", "summarize", "summarise", "overview", "tl;dr", "tldr",
    "key points", "main points", "key takeaways", "takeaways", "gist",
    "what is this document about", "what's this document about",
    "describe this document", "describe the document", "outline",
    "what does this document", "main idea", "in a nutshell",
)


def wants_full_document(question: str) -> bool:
    q = question.lower()
    return any(k in q for k in WHOLE_DOC_KEYWORDS)


# Phrases that signal the user wants a chart/table rendered, not a prose answer.
CHART_KEYWORDS = (
    "chart", "graph", "plot", "visualize", "visualise", "visualization",
    "visualisation", "bar chart", "bar graph", "pie chart", "line chart",
    "line graph", "histogram", "scatter", "diagram", "draw a", "plot a",
    "show me a", "pie of", "breakdown of",
)

def wants_chart(question: str) -> bool:
    q = question.lower()
    return any(k in q for k in CHART_KEYWORDS)


# Requests to PRODUCE a table (a pinnable table widget, not a prose answer):
# either a produce-verb followed by "table" ("make a table of each hat and its
# focus"), or a phrase form with no verb ("sales by region as a table"). A bare
# "table" stays a prose question — "what does the table on page 3 say?" must
# NOT match.
TABLE_RE = re.compile(
    r"\b(make|create|show|give|draw|build|generate|display|present|produce|"
    r"put|render|represent|convert|turn|organize|organise|format|tabulate)\b"
    r".{0,60}?\btable\b",
    re.IGNORECASE,
)
TABLE_PHRASES = (
    "as a table", "in a table", "table of", "table format", "tabular",
    "tabulate", "table showing", "table with", "table comparing",
)


def wants_table(question: str) -> bool:
    q = question.lower()
    return bool(TABLE_RE.search(question)) or any(k in q for k in TABLE_PHRASES)


# A generate-style verb followed (allowing filler words) by a document noun
# signals the user wants a generated report/PDF — e.g. "make me a report",
# "create a detailed PDF of the findings", "draft a one-page brief".
DOC_RE = re.compile(
    r"\b(generate|create|write|draft|prepare|produce|make|build|compile|export|give me)\b"
    r".{0,40}?"
    r"\b(report|document|pdf|memo|brief|write[-\s]?up|white\s?paper|dossier)\b",
    re.IGNORECASE,
)


def wants_document(question: str) -> bool:
    return bool(DOC_RE.search(question))


# Meta/conversational questions are answerable from the chat itself (or are just
# small talk) and don't draw on the uploaded documents — so citing document
# sources for them would be misleading. These get a normal answer with NO
# sources. Kept specific to avoid swallowing genuine document questions (e.g.
# "what time period does the data cover?" must NOT match "what time is it").
META_KEYWORDS = (
    "last question i asked", "last question i've asked", "my last question",
    "my previous question", "previous question i asked", "what did i just ask",
    "what did i ask you", "what was my last", "what did i say",
    "my last message", "repeat my question",
    "what time is it", "what's the time", "what is the time", "current time",
    "current date", "today's date", "what's today's date",
    "what is today's date", "what day is it",
    "what is your name", "what's your name", "who are you",
    "what can you do", "what do you do",
    "repeat that", "say that again", "what did you just say",
    "what did we talk about", "what have we discussed",
)


def is_meta_question(question: str) -> bool:
    q = question.lower()
    return any(k in q for k in META_KEYWORDS)


# Phrases signalling the user wants a chart built from data the AI ALREADY
# presented (a table/answer whose sources were already cited), rather than a
# fresh look at the documents — e.g. "make a bar graph of the above table". A
# chart that merely re-plots already-cited data is just a graphical view of that
# answer, so it shouldn't re-cite the same sources.
PRIOR_OUTPUT_KEYWORDS = (
    "the above", "above table", "above data", "that table", "this table",
    "that data", "this data", "the previous table", "previous table",
    "table you gave", "table you showed", "table you provided",
    "you just gave", "you just showed", "based on that", "of that table",
    "from that table", "the same table", "same data", "that graph",
)


def references_prior_output(question: str) -> bool:
    q = question.lower()
    return any(k in q for k in PRIOR_OUTPUT_KEYWORDS)


# ── Visualization helpers ────────────────────────────────────────────────────
# Max characters of dataset preview fed to the model when building a chart spec.
MAX_VIZ_CHARS = 60_000


def load_dataframe(
    source: str, document_id: str | None = None, organization_id: str | None = None
) -> "pd.DataFrame | None":
    """Re-read the ORIGINAL uploaded file as a DataFrame (CSV / Excel only).

    Charts need accurate numeric data, so for tabular files we re-parse the original
    rather than relying on the chunked/embedded text. Returns None for non-tabular files
    or if parsing fails.
    """
    path = docstore.resolve_source(source, document_id, organization_id)
    if path is None:
        return None
    suffix = path.suffix.lower()
    try:
        if suffix == ".csv":
            return pd.read_csv(path)
        if suffix in (".xlsx", ".xls"):
            return pd.read_excel(path, engine=excel_engine(path))  # first sheet
    except Exception:
        return None
    return None


def build_source_context(
    source: str | None, document_id: str | None = None, organization_id: str | None = None
) -> tuple[str, bool]:
    """Context read from a single document's ORIGINAL file — used by dashboard metric
    extraction and the standalone /visualize and /generate-document endpoints.
    Tabular files -> CSV text; other types -> extracted text. No vector store."""
    if not source and not document_id:
        return "", False
    df = load_dataframe(source, document_id, organization_id)
    if df is not None:
        text = "TABULAR DATA (CSV, first rows):\n" + df.head(500).to_csv(index=False)
        return text[:MAX_VIZ_CHARS], True

    path = docstore.resolve_source(source, document_id, organization_id)
    if path is None:
        return "", False
    try:
        parsed = parse_file(path)
        text = "DOCUMENT TEXT:\n" + "\n\n".join(parsed.text_chunks)
        return text[:MAX_VIZ_CHARS], False
    except Exception:
        return "", False


VIZ_PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "You are a data-visualization assistant. Given a dataset and a user's "
     "request, produce ONE chart or table specification as STRICT JSON only — "
     "no markdown fences, no prose.\n\n"
     "JSON shape:\n"
     "{{\n"
     '  "chart_type": one of "bar","line","area","pie","doughnut","scatter","table",\n'
     '  "title": short descriptive title,\n'
     '  "labels": [category / x-axis labels as strings],   // for non-table charts\n'
     '  "datasets": [{{"label": series name, "data": [numbers]}}],  // for non-table charts\n'
     '  "table_columns": [column names],     // ONLY when chart_type is "table"\n'
     '  "table_rows": [[cell values as strings]],  // ONLY when chart_type is "table"\n'
     '  "notes": one short sentence describing what is shown\n'
     "}}\n\n"
     "Rules:\n"
     "- Pick the most suitable chart_type for the request and the data.\n"
     "- Use ONLY values present in the dataset; never invent data.\n"
     "- The dataset may contain MULTIPLE tables (e.g. different time ranges or "
     "metrics split across separate files) that share columns. Treat them as ONE "
     "combined dataset: merge their rows and use EVERY matching period/category "
     "found across ALL tables.\n"
     "- When the request names a range (e.g. '2024 to 2027'), include EVERY period "
     "in that range that appears in ANY table, sorted chronologically — never stop "
     "at the periods from just one table.\n"
     "- Aggregate/group when the request implies it (e.g. totals by category).\n"
     "- labels and each dataset's data array must be the SAME length.\n"
     "- pie/doughnut must have exactly one dataset.\n"
     "- Numbers must be plain (no commas, currency symbols, or units).\n"
     "- If the data cannot support the request, return a sensible table instead.\n"
     "- Output ONLY the JSON object."),
    ("human", "DATASET:\n{dataset}\n\nREQUEST: {instruction}"),
])


def parse_chart_json(raw: str) -> dict:
    """Parse the model's JSON output, tolerating ```json fences / stray text."""
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1] if "```" in text[3:] else text.strip("`")
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[4:]
    # Fall back to the outermost {...} if there's surrounding prose.
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]
    return json.loads(text)


def rank_documents_by_relevance(question: str, organization_id, document_ids, max_docs: int = MAX_TABLE_DOCS) -> list:
    """The most relevant documents for a query, via the same semantic search
    chat retrieval uses. Without this, chart/report context is built from ALL
    accessible documents in arbitrary order and the relevant one can get
    truncated out by the context cap. Falls back to all given ids on no hits."""
    hits = retrieve_chunks(question, organization_id or "", document_ids, k=12)
    ids = []
    for h in hits:
        did = h["document_id"]
        if did not in ids:
            ids.append(did)
        if len(ids) >= max_docs:
            break
    return ids or list(document_ids or [])


def build_viz_context_supabase(instruction: str, organization_id, document_ids, focus_document_id) -> tuple[str, bool, list]:
    """Chart context from Supabase: prefer stored tables (accurate numbers),
    else fall back to text chunks. Scoped to the focused doc, or the accessible
    docs most relevant to the instruction — in relevance order, so the doc the
    user is asking about survives the context cap. Also returns the document
    ids that actually contributed data (for sources)."""
    if focus_document_id:
        ids = [focus_document_id]
    else:
        ranked = rank_documents_by_relevance(instruction, organization_id, document_ids)
        # Charts often compare data SPLIT across several files (e.g. 2024-25 in one
        # upload, 2026-27 in another). Narrowing to the top-ranked docs drops the
        # rest and loses whole periods, so include EVERY accessible doc — ranked
        # ones first so the most relevant survive if we hit the context cap.
        rest = [d for d in (document_ids or []) if d not in ranked]
        ids = ranked + rest
    parts = []
    used = set()
    tables_by_doc: dict = {}
    for t in store.tables_for_documents(ids):
        tables_by_doc.setdefault(t.get("document_id"), []).append(t)
    for did in ids:  # relevance order, doc by doc
        for t in tables_by_doc.get(did, []):
            rows = (t.get("table_data") or {}).get("rows") or []
            if not rows:
                continue
            used.add(did)
            name = t.get("table_name") or t.get("sheet_name") or "table"
            cols = list(rows[0].keys())
            lines = [",".join(map(str, cols))]
            for r in rows[:500]:
                lines.append(",".join("" if r.get(c) is None else str(r.get(c)) for c in cols))
            parts.append(f"TABLE: {name}\n" + "\n".join(lines))
    if parts:
        return ("TABULAR DATA:\n" + "\n\n".join(parts))[:MAX_VIZ_CHARS], True, list(used)
    chunks = store.chunks_for_documents(ids)
    used = list({c["document_id"] for c in chunks})
    text = "DOCUMENT TEXT:\n" + "\n\n".join(c["chunk_text"] for c in chunks)
    return text[:MAX_VIZ_CHARS], False, used


async def _visualize_from_dataset(dataset: str, is_tabular: bool, instruction: str, source_label) -> dict:
    if not dataset.replace("DOCUMENT TEXT:", "").replace("TABULAR DATA:", "").strip():
        raise HTTPException(status_code=422, detail="No document data to chart yet.")
    chain = VIZ_PROMPT | llm | StrOutputParser()
    raw = await chain.ainvoke({"dataset": dataset, "instruction": instruction})
    try:
        spec = parse_chart_json(raw)
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(
            status_code=422,
            detail="Could not turn that request into a chart. Try rephrasing, "
                   "e.g. 'bar chart of total sales by region'.",
        )
    spec["source"] = source_label
    spec["is_tabular"] = is_tabular
    return spec


async def run_visualization(
    source: str | None,
    instruction: str,
    organization_id: str | None = None,
    document_id: str | None = None,
) -> dict:
    dataset, is_tabular = build_source_context(source, document_id, organization_id)
    return await _visualize_from_dataset(dataset, is_tabular, instruction, source or "document")


async def run_visualization_supabase(instruction: str, organization_id, document_ids, focus_document_id) -> tuple[dict, list]:
    dataset, is_tabular, used_ids = build_viz_context_supabase(instruction, organization_id, document_ids, focus_document_id)
    source_files = store.file_names_for_documents(used_ids)
    spec = await _visualize_from_dataset(dataset, is_tabular, instruction, "")
    return spec, source_files


# ── Deterministic tabular aggregation ────────────────────────────────────────
# "Average NO2 for all cities" over a 3,540-row table can't be answered by chunk
# retrieval (returns only top-k chunks) or by dumping the table to the LLM (the
# context cap truncates it — cities past the cutoff vanish — and the model can't
# reliably average thousands of rows anyway). When a request is an aggregation of
# a named numeric column GROUPED BY a named category, compute it exactly in
# pandas over every row instead. Restricted to the grouped case on purpose:
# ungrouped/filtered aggregates ("total revenue in 2024") need a WHERE the parser
# doesn't model, so those fall through to the normal RAG path.
_AGG_PATTERNS = [
    (r"\b(mean|average|avg)\b", "mean"),
    (r"\b(total|sum)\b", "sum"),
    (r"\b(count|how many|number of)\b", "count"),
    (r"\b(max|maximum|highest|peak|largest)\b", "max"),
    (r"\b(min|minimum|lowest|smallest)\b", "min"),
]
_AGG_LABEL = {"mean": "average", "sum": "total", "count": "count of", "max": "maximum", "min": "minimum"}


def _detect_agg_func(message: str) -> str | None:
    for pat, fn in _AGG_PATTERNS:
        if re.search(pat, message, re.I):
            return fn
    return None


def _word_tokens(text: str) -> set:
    return {t for t in re.split(r"[^a-z0-9]+", str(text).lower()) if t}


def _singular(tok: str) -> str:
    """Crude singularizer so plural query words match column names (cities->city)."""
    if len(tok) > 4 and tok.endswith("ies"):
        return f"{tok[:-3]}y"
    if len(tok) > 4 and tok.endswith("ses"):
        return tok[:-2]
    if len(tok) > 3 and tok.endswith("s") and not tok.endswith("ss"):
        return tok[:-1]
    return tok


def _is_numeric_col(series) -> bool:
    col = _to_numeric(series)
    return int(col.notna().sum()) >= max(1, int(0.5 * len(series)))


def _match_metric_columns(message, df) -> list:
    """Numeric columns explicitly named in the message (e.g. 'NO2' -> 'NO2')."""
    mtoks = _word_tokens(message)
    return [c for c in df.columns if (_word_tokens(c) & mtoks) and _is_numeric_col(df[c])]


# Filler words that must NOT drive column matching — otherwise "chart OF avg NO2
# BY city" would match a "Type OF Location" column on the stray "of".
_GROUP_STOP = {
    "the", "all", "each", "every", "per", "by", "for", "across", "of", "and", "in",
    "to", "from", "me", "give", "show", "list", "get", "chart", "bar", "line", "graph",
    "plot", "pie", "doughnut", "table", "average", "avg", "mean", "total", "sum",
    "count", "max", "min", "maximum", "minimum", "highest", "lowest", "number",
    "emission", "emissions", "value", "values", "data", "compare", "comparison",
}


def _match_group_column(message, df, exclude) -> str | None:
    """A categorical column named in the message ('cities' -> 'City/Town/...')."""
    mtoks = {
        _singular(t) for t in _word_tokens(message)
        if len(t) >= 3 and t not in _GROUP_STOP
    }
    for c in df.columns:
        if c in exclude or _is_numeric_col(df[c]):
            continue
        ctoks = {_singular(t) for t in _word_tokens(c) if t not in _GROUP_STOP}
        if ctoks & mtoks:
            return c
    return None


def compute_tabular_aggregation(message, rows) -> dict | None:
    """Compute (metric agg BY group) over `rows`, or None if not applicable."""
    if not rows:
        return None
    df = pd.DataFrame(rows)
    if df.empty:
        return None
    func = _detect_agg_func(message)
    if not func:
        return None
    metric_cols = _match_metric_columns(message, df)
    if not metric_cols:
        return None
    group_col = _match_group_column(message, df, exclude=set(metric_cols))
    if not group_col:
        return None  # only the grouped case is safe (no WHERE-filter modelling)
    for mc in metric_cols:
        df[mc] = _to_numeric(df[mc])
    grouped = df.groupby(group_col)[metric_cols].agg(func).reset_index().sort_values(group_col)
    out_rows = []
    for rec in grouped.to_dict("records"):
        row: dict = {group_col: str(rec[group_col])}
        for mc in metric_cols:
            v = rec[mc]
            row[mc] = None if pd.isna(v) else round(float(v), 2)
        out_rows.append(row)
    return {"func": func, "group_col": group_col, "metric_cols": metric_cols, "rows": out_rows}


def run_aggregation_supabase(message, organization_id, document_ids, focus_document_id, want_chart) -> dict | None:
    """Deterministic groupby answer over the relevant docs' stored tables.
    Returns ChatResponse kwargs (answer/sources/chart), or None to fall through."""
    if focus_document_id:
        ids = [focus_document_id]
    elif document_ids:
        ids = list(document_ids)
    else:
        return None
    all_rows, used = [], []
    for t in store.tables_for_documents(ids):
        trows = (t.get("table_data") or {}).get("rows") or []
        if trows:
            all_rows.extend(trows)
            if t.get("document_id") not in used:
                used.append(t.get("document_id"))
    agg = compute_tabular_aggregation(message, all_rows)
    if agg is None:
        return None

    gcol, mcols, out_rows = agg["group_col"], agg["metric_cols"], agg["rows"]
    label = _AGG_LABEL.get(str(agg["func"])) or str(agg["func"])
    sources = store.file_names_for_documents(used)
    note = f"{label.title()} of {', '.join(mcols)} by {gcol}, computed exactly over {len(all_rows)} rows."

    if want_chart:
        spec = {
            "chart_type": "bar",
            "title": f"{label.title()} {', '.join(mcols)} by {gcol}",
            "labels": [r[gcol] for r in out_rows],
            "datasets": [{"label": mc, "data": [r[mc] for r in out_rows]} for mc in mcols],
            "notes": note,
            "source": "",
            "is_tabular": True,
        }
        return {"answer": note, "sources": sources, "chart": spec}

    cols = [gcol] + mcols
    md = "| " + " | ".join(cols) + " |\n| " + " | ".join(["---"] * len(cols)) + " |\n"
    for r in out_rows:
        md += "| " + " | ".join("" if r.get(c) is None else str(r.get(c)) for c in cols) + " |\n"
    return {"answer": f"{note}\n\n{md}", "sources": sources, "chart": None}


# ── Dashboard metric extraction ──────────────────────────────────────────────
# Open-ended: the LLM proposes its own metric key/department/kind from whatever
# the document actually contains, rather than picking from a fixed catalog. This
# lets any team's metrics (deployment_frequency, churn, NPS, ...) surface without
# a code change. The department is a cosmetic grouping tag, never a filter.
_METRIC_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify_metric(name: str) -> str:
    """Turn the free-text key the LLM proposed into a stable snake_case key
    (e.g. "Total Revenue!" -> "total_revenue")."""
    return _METRIC_SLUG_RE.sub("_", name.strip().lower()).strip("_")


# The value kinds the dashboard knows how to format. Anything else falls back to
# a plain number.
_ALLOWED_KINDS = {"currency", "percent", "count", "number"}

# Base extraction instructions (open-ended: the LLM names metrics itself). Built
# as a plain string so per-request user-defined metrics can be appended without
# ChatPromptTemplate brace-escaping issues.
METRICS_SYSTEM_TEXT = (
    "You extract quantitative business metrics from a document for a "
    "dashboard. Return STRICT JSON only: a JSON ARRAY of metric objects, "
    "nothing else.\n\n"
    "Name each metric yourself based on what the document contains - you are "
    "NOT limited to a fixed list. Use a short, generic snake_case key for the "
    "concept (e.g. revenue, marketing_spend, deployment_frequency, "
    "net_promoter_score) and reuse the same key for the same concept across "
    "data points so it aggregates cleanly.\n\n"
    "Each object:\n"
    "{\n"
    '  "metric": short snake_case key naming the concept,\n'
    '  "department": best-guess domain grouping (finance, sales, marketing, '
    "hr, operations, engineering, ... or a new one if none fit),\n"
    '  "kind": one of "currency","percent","count","number",\n'
    '  "period": "YYYY" | "YYYY-MM" | "YYYY-Qn", or null if none stated,\n'
    '  "value": a plain number (no commas, currency symbols, %, or units),\n'
    '  "currency": ISO code like "USD" if known, else null,\n'
    '  "category": a breakdown label (e.g. region/department/product) or null,\n'
    '  "confidence": 0.0-1.0\n'
    "}\n\n"
    "Rules:\n"
    "- Use ONLY numbers present in the document; never invent values.\n"
    "- Emit one object per (metric, period, category) data point you find.\n"
    "- For rates/percentages set kind=\"percent\" and emit the plain number "
    "(e.g. 12.5 for 12.5%); for money set kind=\"currency\".\n"
    "- Only extract genuine quantitative metrics; skip prose and identifiers.\n"
    "- If the document contains no such metrics, return [].\n"
    "- Output ONLY the JSON array."
)

# Reuse StrOutputParser to flatten the model reply (handles str or the
# content-block list some Gemini models return).
_metrics_parser = StrOutputParser()


def build_metrics_system(custom_defs: list[dict] | None) -> str:
    """Append the user's tracked metric definitions so extraction actively looks
    for them and reuses their exact keys, on top of open-ended discovery."""
    text = METRICS_SYSTEM_TEXT
    lines = []
    for c in custom_defs or []:
        key = slugify_metric(str(c.get("key") or c.get("metric_key") or ""))
        if not key:
            continue
        label = str(c.get("label") or key)
        desc = str(c.get("description") or "").strip()
        lines.append(f"- {key} ({label}): {desc}" if desc else f"- {key} ({label})")
    if lines:
        text += (
            "\n\nThe user is specifically tracking these metrics — actively look "
            "for them and use these EXACT keys when the document contains them "
            "(still extract other metrics you find too):\n" + "\n".join(lines)
        )
    return text


def parse_json_array(raw: str) -> list:
    """Parse a JSON array from the model output, tolerating fences/stray text."""
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1] if "```" in text[3:] else text.strip("`")
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[4:]
    start, end = text.find("["), text.rfind("]")
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]
    data = json.loads(text)
    return data if isinstance(data, list) else []


def normalize_metric(raw: dict) -> dict | None:
    """Validate/normalize one extracted metric; drop anything unusable.

    Open-ended: the metric key/department/kind come from the LLM's own output
    (slugified/defaulted here), not from a fixed catalog. Only a non-empty key
    and a numeric value are required."""
    metric = slugify_metric(str(raw.get("metric", "")))
    if not metric:
        return None
    value_raw = raw.get("value")
    if value_raw is None:
        return None
    try:
        value = float(value_raw)
    except (TypeError, ValueError):
        return None
    period = raw.get("period")
    category = raw.get("category")
    currency = raw.get("currency")
    department = str(raw.get("department") or "general").strip().lower() or "general"
    kind = str(raw.get("kind") or "number").strip().lower()
    if kind not in _ALLOWED_KINDS:
        kind = "number"
    try:
        confidence = float(raw.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    return {
        "metric": metric,
        "department": department,
        "kind": kind,
        "period": str(period) if period not in (None, "") else None,
        "value": value,
        "currency": str(currency) if currency else None,
        "category": str(category) if category else None,
        "confidence": max(0.0, min(1.0, confidence)),
    }


# ── Deterministic tabular extraction ─────────────────────────────────────────
# Asking the LLM to enumerate every (metric, period) cell of a table makes it
# sample and silently drop rows, so periods go missing (a 14-metric x 8-quarter
# sheet is 112 objects — the model summarises instead of listing them all). For
# CSV/Excel we instead MELT the dataframe in code: every row x numeric column
# becomes one data point, capturing ALL periods with zero sampling. The LLM is
# not involved in reading the values.
MAX_TABULAR_ROWS = 50_000

_MONTH_INDEX = {}
for _i, _m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], start=1):
    _MONTH_INDEX[_m] = _i
    _MONTH_INDEX[_m[:3]] = _i

_PERCENT_HINTS = ("rate", "ratio", "percent", "percentage", "margin", "growth",
                  "share", "yield", "utilization", "occupancy", "cpc", "ctr")
_CURRENCY_HINTS = ("revenue", "income", "sales", "profit", "cost", "expenditure",
                   "expense", "price", "fee", "royalt", "salary", "amount", "budget",
                   "spend", "turnover", "mrr", "arr", "gmv", "arpu", "payment",
                   "earnings", "billing", "cash")
_COUNT_HINTS = ("count", "calls", "number", "num", "qty", "quantity", "users",
                "employee", "visit", "click", "order", "unit", "cities", "session",
                "signup", "subscriber", "headcount", "ticket")


def _guess_kind(col: str) -> str:
    c = col.lower()
    if any(h in c for h in _PERCENT_HINTS):
        return "percent"
    if any(h in c for h in _CURRENCY_HINTS):
        return "currency"
    if any(h in c for h in _COUNT_HINTS):
        return "count"
    return "number"


def _to_numeric(series) -> "pd.Series":
    """Coerce a column to numbers, stripping thousands separators / currency / %."""
    if series.dtype == object:
        cleaned = series.astype(str).str.replace(r"[,$€£%\s]", "", regex=True)
        return pd.Series(pd.to_numeric(cleaned, errors="coerce"))
    return pd.Series(pd.to_numeric(series, errors="coerce"))


def _fmt_year(v) -> str | None:
    try:
        y = int(float(str(v).strip()))
    except (TypeError, ValueError):
        return None
    return str(y) if 1900 <= y <= 2100 else None


def _fmt_quarter(v) -> str | None:
    m = re.search(r"([1-4])", str(v))
    return f"Q{m.group(1)}" if m else None


def _fmt_month(v) -> str | None:
    s = str(v).strip().lower()
    if s in _MONTH_INDEX:
        return f"{_MONTH_INDEX[s]:02d}"
    try:
        n = int(float(s))
        if 1 <= n <= 12:
            return f"{n:02d}"
    except (TypeError, ValueError):
        pass
    return None


def _find_col(df, pattern):
    for c in df.columns:
        if re.fullmatch(pattern, str(c).strip(), re.I):
            return c
    return None


def _build_period_extractor(df):
    """Return (row -> period string | None, {columns used as the period key}).
    Recognises Year+Quarter, Year+Month, a Date/Period column, or Year alone."""
    year_col = _find_col(df, r"year|fy|yr")
    q_col = _find_col(df, r"quarter|qtr|q")
    m_col = _find_col(df, r"month|mon|mo")
    date_col = None
    for c in df.columns:
        if re.search(r"date|period|timestamp", str(c).strip(), re.I):
            date_col = c
            break

    if year_col and q_col:
        def fn(row):
            y, q = _fmt_year(row[year_col]), _fmt_quarter(row[q_col])
            return f"{y}-{q}" if y and q else y
        return fn, {year_col, q_col}
    if year_col and m_col:
        def fn(row):
            y, mm = _fmt_year(row[year_col]), _fmt_month(row[m_col])
            return f"{y}-{mm}" if y and mm else y
        return fn, {year_col, m_col}
    if date_col is not None:
        def fn(row):
            dt = pd.to_datetime(row[date_col], errors="coerce")
            if pd.isna(dt):
                s = str(row[date_col]).strip()  # already a label like "2024-Q1"?
                return s or None
            return f"{dt.year}-{dt.month:02d}"
        return fn, {date_col}
    if year_col:
        return (lambda row: _fmt_year(row[year_col])), {year_col}
    return None, set()


def extract_metrics_tabular(df, custom_defs: list[dict] | None = None) -> list[dict] | None:
    """Melt a dataframe into one metric point per (row, numeric column). Returns
    None (→ caller falls back to the LLM) when the table has no recognisable
    period column or no numeric columns, so categorical/wide tables still work."""
    if df is None or df.empty:
        return None
    df = df.head(MAX_TABULAR_ROWS)
    period_fn, period_cols = _build_period_extractor(df)
    if period_fn is None:
        return None  # no time signal → let the LLM handle it (may find categories)

    def_kind = {}
    for c in (custom_defs or []):
        k = slugify_metric(str(c.get("key") or c.get("metric_key") or ""))
        if k and c.get("kind"):
            def_kind[k] = str(c["kind"]).strip().lower()

    metric_cols = []
    threshold = max(1, int(0.5 * len(df)))
    for c in df.columns:
        if c in period_cols:
            continue
        col = _to_numeric(df[c])
        if int(col.notna().sum()) >= threshold:
            metric_cols.append((c, col))
    if not metric_cols:
        return None

    periods = [period_fn(df.iloc[i]) for i in range(len(df))]
    raw_points = []
    for c, col in metric_cols:
        key = slugify_metric(str(c))
        if not key:
            continue
        kind = def_kind.get(key) or _guess_kind(str(c))
        for i in range(len(df)):
            v = col.iloc[i]
            if pd.isna(v):
                continue
            raw_points.append({
                "metric": key,
                "department": "general",
                "kind": kind,
                "period": periods[i],
                "value": float(v),
                "currency": None,
                "category": None,
                "confidence": 0.9,
            })
    return [m for m in (normalize_metric(p) for p in raw_points) if m]


# ── Chunked LLM extraction (text / PDF / unstructured tables) ─────────────────
# Non-tabular sources still need the LLM, but a single truncated pass drops
# whatever falls past the cap. Instead we feed the WHOLE document in windows and
# merge, de-duping by (metric, period, category) so overlaps don't double-count.
EXTRACT_CHUNK_CHARS = 15_000
EXTRACT_CHUNK_OVERLAP = 500
MAX_EXTRACT_CHUNKS = 12


def _full_source_text(
    source: str, document_id: str | None = None, organization_id: str | None = None
) -> str:
    """Whole-document text for extraction — NOT capped at MAX_VIZ_CHARS."""
    df = load_dataframe(source, document_id, organization_id)
    if df is not None:
        return "TABULAR DATA (CSV):\n" + df.head(MAX_TABULAR_ROWS).to_csv(index=False)
    path = docstore.resolve_source(source, document_id, organization_id)
    if path is None:
        return ""
    try:
        return "DOCUMENT TEXT:\n" + "\n\n".join(parse_file(path).text_chunks)
    except Exception:
        return ""


def _split_for_extraction(text: str) -> list[str]:
    if len(text) <= EXTRACT_CHUNK_CHARS:
        return [text]
    chunks, i = [], 0
    while i < len(text) and len(chunks) < MAX_EXTRACT_CHUNKS:
        chunks.append(text[i:i + EXTRACT_CHUNK_CHARS])
        i += EXTRACT_CHUNK_CHARS - EXTRACT_CHUNK_OVERLAP
    return chunks


def _dedup_metrics(metrics: list[dict]) -> list[dict]:
    """Collapse identical (metric, period, category) points, keeping the most
    confident — so overlapping chunks don't inflate values."""
    best: dict = {}
    for m in metrics:
        key = (m["metric"], m.get("period"), m.get("category"))
        if key not in best or m.get("confidence", 0) > best[key].get("confidence", 0):
            best[key] = m
    return list(best.values())


async def _extract_chunk(text: str, system_text: str) -> list[dict]:
    resp = await llm.ainvoke([
        SystemMessage(content=system_text),
        HumanMessage(content=f"DOCUMENT:\n{text}"),
    ])
    raw = _metrics_parser.invoke(resp)
    try:
        items = parse_json_array(raw)
    except (json.JSONDecodeError, ValueError):
        return []
    return [m for m in (normalize_metric(i) for i in items if isinstance(i, dict)) if m]


async def extract_metrics(
    source: str,
    custom_defs: list[dict] | None = None,
    document_id: str | None = None,
    organization_id: str | None = None,
) -> list[dict]:
    """Metric extraction from one uploaded document.

    Tabular files are melted deterministically (every period captured, no LLM
    sampling). Everything else — and any table we can't structure — is extracted
    by the LLM chunk-by-chunk over the WHOLE document and merged, so periods no
    longer fall past a truncation cap. `custom_defs` steer the LLM path and set
    the kind on the tabular path."""
    df = load_dataframe(source, document_id, organization_id)
    if df is not None:
        tabular = extract_metrics_tabular(df, custom_defs)
        if tabular:
            return tabular
        # Couldn't structure the table → fall through to the LLM.

    text = _full_source_text(source, document_id, organization_id)
    if not text.strip():
        return []
    system_text = build_metrics_system(custom_defs)
    collected: list[dict] = []
    for chunk in _split_for_extraction(text):
        collected.extend(await _extract_chunk(chunk, system_text))
    return _dedup_metrics(collected)


# ── Document generation helpers ──────────────────────────────────────────────
# Generated reports go to Supabase Storage under `generated/<org>/`, like everything
# else. They get their own prefix rather than a document's because they exist as a file
# before any documents row does — one is created only if the user clicks "Add to AI".
MAX_DOC_CONTEXT_CHARS = 80_000

# Bundled Unicode font. fpdf2's core fonts (Helvetica) are Latin-1 only and choke
# on characters the LLM emits (en-dash, curly quotes, bullets, …), so we register
# DejaVuSans, which covers full Unicode.
FONT_DIR = Path(__file__).parent / "fonts"
_DEJAVU_STYLES = {
    "": "DejaVuSans.ttf",
    "B": "DejaVuSans-Bold.ttf",
    "I": "DejaVuSans-Oblique.ttf",
    "BI": "DejaVuSans-BoldOblique.ttf",
}

# Fallback transliteration used only when the Unicode font is unavailable.
_LATIN1_MAP = {
    "–": "-", "—": "--", "‘": "'", "’": "'",
    "“": '"', "”": '"', "•": "-", "…": "...",
    " ": " ", "→": "->", "−": "-",
}

DOC_PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "You are a professional report writer for SNAP AI. Using ONLY the source "
     "material provided, write a well-structured document that fulfils the "
     "user's request. Output GitHub-flavored Markdown only — no code fences "
     "around the whole thing, no commentary before or after.\n\n"
     "Requirements:\n"
     "- Start with a single H1 title line ('# Title').\n"
     "- Use H2/H3 headings, bullet lists, and Markdown tables where helpful.\n"
     "- Be accurate to the source; do not invent facts or figures.\n"
     "- Use a clear, professional tone suitable for a business document.\n\n"
     "Source material:\n{context}"),
    ("human", "{instruction}"),
])


def extract_title(md_text: str) -> str:
    """Use the first Markdown H1 as the document title, else a default."""
    for line in md_text.splitlines():
        if line.strip().startswith("# "):
            return line.strip()[2:].strip()
    return "Generated Report"


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (slug or "report")[:50]


def register_pdf_font(pdf: FPDF) -> str:
    """Register the bundled DejaVu family (all styles) so Unicode renders.
    Returns the font family to use, or 'Helvetica' if the fonts are missing."""
    paths = {style: FONT_DIR / name for style, name in _DEJAVU_STYLES.items()}
    if not all(p.is_file() for p in paths.values()):
        return "Helvetica"
    for style, path in paths.items():
        pdf.add_font("DejaVu", style, str(path))
    return "DejaVu"


def to_latin1(text: str) -> str:
    """Best-effort downgrade to Latin-1 for the no-Unicode-font fallback."""
    for uni, ascii_ in _LATIN1_MAP.items():
        text = text.replace(uni, ascii_)
    return text.encode("latin-1", "replace").decode("latin-1")


def markdown_to_pdf(md_text: str, out_path: Path) -> None:
    """Render Markdown to a PDF via HTML (fpdf2 supports headings/lists/tables)."""
    html = markdown.markdown(md_text, extensions=["tables", "sane_lists"])
    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()
    family = register_pdf_font(pdf)
    if family == "Helvetica":
        html = to_latin1(html)  # core font can't render Unicode punctuation
    pdf.set_font(family, size=11)
    pdf.write_html(html)
    pdf.output(str(out_path))


def build_doc_context_supabase(instruction: str, organization_id, document_ids, focus_document_id) -> tuple[str, list]:
    """Report context from Supabase chunks, scoped to the focused doc or the
    accessible docs most relevant to the instruction (see
    rank_documents_by_relevance). Also returns the contributing ids (sources)."""
    if focus_document_id:
        ids = [focus_document_id]
    else:
        ids = rank_documents_by_relevance(instruction, organization_id, document_ids)
    chunks = store.chunks_for_documents(ids)
    used = list({c["document_id"] for c in chunks})
    context = "\n\n".join(c["chunk_text"] for c in chunks)[:MAX_DOC_CONTEXT_CHARS]
    return context, used


async def _generate_doc_from_context(
    context: str, instruction: str, source_label, organization_id: str
) -> dict:
    if not context.strip():
        raise HTTPException(status_code=400, detail="No document content to work from.")

    chain = DOC_PROMPT | llm | StrOutputParser()
    md_text = await chain.ainvoke({"context": context, "instruction": instruction})

    title = extract_title(md_text)
    filename = f"{slugify(title)}-{datetime.now():%Y%m%d-%H%M%S}.pdf"

    # Build the PDF in a temp dir, then hand it to Storage. Nothing durable is written
    # here — the backend serves the download straight out of the bucket.
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / filename
        try:
            markdown_to_pdf(md_text, out_path)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"PDF generation failed: {exc}")
        try:
            storage_path = docstore.put_generated(organization_id, filename, out_path)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Could not store the report: {exc}")

    return {
        "filename": filename,
        "storage_path": storage_path,
        "title": title,
        "markdown": md_text,
        "source": source_label,
    }


async def run_document_generation(instruction: str, source: str | None, organization_id: str) -> dict:
    context, _ = build_source_context(source, organization_id=organization_id)
    return await _generate_doc_from_context(context, instruction, source, organization_id)


async def run_document_generation_supabase(instruction: str, organization_id, document_ids, focus_document_id) -> tuple[dict, list]:
    context, used_ids = build_doc_context_supabase(instruction, organization_id, document_ids, focus_document_id)
    source_files = store.file_names_for_documents(used_ids)
    doc = await _generate_doc_from_context(context, instruction, focus_document_id, organization_id)
    return doc, source_files


def to_lc_messages(history: list[dict] | None) -> list:
    """Convert [{'role': 'user'|'assistant', 'content': str}, ...] to LangChain messages."""
    msgs = []
    for m in history or []:
        role = m.get("role")
        content = m.get("content", "")
        if not content:
            continue
        if role == "user":
            msgs.append(HumanMessage(content=content))
        elif role == "assistant":
            msgs.append(AIMessage(content=content))
    return msgs


# How many candidates hybrid search returns before we trim to k (widened in P1.4
# so the cross-encoder reranker has a real pool to reorder).
HYBRID_CANDIDATES = 30

# ── Retrieval caches (P1.5) ───────────────────────────────────────────────────
# (a) embedding cache: identical/whitespace-different queries skip re-embedding.
# (b) result cache: a full retrieval result is reused for a short TTL, so re-asks
#     within a turn are instant. Time-based invalidation is safe because a new
#     upload only needs to be reflected after the TTL (a few seconds).
_RESULT_TTL_SECONDS = 60
_result_cache: dict[str, tuple[float, list]] = {}
_cache_stats = {"result_hits": 0, "result_miss": 0}


def _norm_query(q: str) -> str:
    return " ".join((q or "").split())


@lru_cache(maxsize=512)
def _embed_query_cached(norm_q: str) -> tuple:
    # Cached by normalized text; tuple is hashable + immutable for lru_cache.
    return tuple(embeddings.embed_query(norm_q))


def _result_key(organization_id: str, document_ids, norm_q: str, k: int) -> str:
    docs = ",".join(sorted(document_ids)) if document_ids else "*"
    return f"{organization_id}|{docs}|{k}|{norm_q}"


def retrieve_chunks(question: str, organization_id: str, document_ids=None, k: int = 5) -> list[dict]:
    """Retrieve the most relevant chunks, scoped to an org and (optionally) the
    accessible document ids. Hybrid dense + full-text (RRF) → cross-encoder
    rerank; falls back to dense-only if the P1.3 migration isn't applied.
    Caches the query embedding and the final result (short TTL)."""
    norm_q = _norm_query(question)
    key = _result_key(organization_id, document_ids, norm_q, k)
    now = time.time()
    cached = _result_cache.get(key)
    if cached and cached[0] > now:
        _cache_stats["result_hits"] += 1
        return cached[1]
    _cache_stats["result_miss"] += 1

    query_vec = list(_embed_query_cached(norm_q))
    try:
        hits = store.hybrid_match_chunks(
            query_vec, question, organization_id,
            document_ids=document_ids, match_count=max(k, HYBRID_CANDIDATES),
        )
    except Exception:
        hits = store.match_chunks(query_vec, organization_id, document_ids=document_ids, match_count=k)
    result = rerank_hits(question, hits, k)

    _result_cache[key] = (now + _RESULT_TTL_SECONDS, result)
    if len(_result_cache) > 1024:  # bound: drop expired, else oldest-ish
        for kk in [k2 for k2, v in list(_result_cache.items()) if v[0] <= now][:512] or list(_result_cache)[:256]:
            _result_cache.pop(kk, None)
    return result


def rerank_hits(question: str, hits: list[dict], k: int) -> list[dict]:
    """Reorder candidates by cross-encoder relevance, returning the top-k. Falls
    back to the incoming order (fused RRF / dense score) if the reranker is
    unavailable or errors, so retrieval never hard-fails on the reranker."""
    if not hits or reranker is None or len(hits) <= 1:
        return hits[:k]
    try:
        scores = reranker.predict([(question, h["chunk_text"]) for h in hits])
        for h, s in zip(hits, scores):
            h["rerank_score"] = float(s)
        hits = sorted(hits, key=lambda h: h.get("rerank_score", 0.0), reverse=True)
    except Exception:
        pass  # keep fused order
    return hits[:k]

def render_document_tables(document_id) -> str:
    """A document's stored tabular data (document_tables) rendered as CSV text, so
    the LLM can answer over the ACTUAL rows rather than just the embedded summary
    chunk. Returns '' for documents that have no tables (e.g. plain text)."""
    blocks = []
    for t in store.tables_for_documents([document_id]):
        rows = (t.get("table_data") or {}).get("rows") or []
        if not rows:
            continue
        name = t.get("table_name") or t.get("sheet_name") or "table"
        cols = list(rows[0].keys())
        lines = [",".join(map(str, cols))]
        for r in rows:
            lines.append(",".join("" if r.get(c) is None else str(r.get(c)) for c in cols))
        blocks.append(f"FULL TABLE DATA ({name}):\n" + "\n".join(lines))
    return "\n\n".join(blocks)


async def run_rag_chain(
    question: str,
    session_id: str,
    source: str | None = None,
    history: list[dict] | None = None,
    organization_id: str | None = None,
    document_ids: list[str] | None = None,
    focus_document_id: str | None = None,
):
    # If the caller supplies history (persisted in the DB), use it so memory
    # survives restarts and resuming old threads. Otherwise fall back to the
    # in-memory per-session history.
    if history is not None:
        chat_history = to_lc_messages(history)[-20:]
    else:
        chat_history = get_history(session_id)

    # Step 1 — condense follow-up into standalone question if there's history
    if chat_history:
        condense_chain = CONDENSE_PROMPT | llm | StrOutputParser()
        standalone = await condense_chain.ainvoke({"chat_history": chat_history, "question": question})
    else:
        standalone = question

    # Step 2 — Supabase pgvector retrieval, scoped by org + the docs the user may
    # see. A focus_document_id narrows the search to a single document.
    ids = [focus_document_id] if focus_document_id else document_ids
    hits = retrieve_chunks(standalone, organization_id or "", ids, k=8 if focus_document_id else 5)

    # Include the ACTUAL tabular data (document_tables) for the relevant documents
    # so questions over "the whole document" use real rows, not just the embedded
    # summary chunk (numbers embed poorly, so tables are summarised for search).
    #   * focused  -> that one document
    #   * unfocused -> the documents the semantic search matched, in relevance
    #     order, capped so a broad query can't dump every doc's tables.
    if focus_document_id:
        table_doc_ids = [focus_document_id]
    else:
        table_doc_ids = []
        for h in hits:
            did = h["document_id"]
            if did not in table_doc_ids:
                table_doc_ids.append(did)
            if len(table_doc_ids) >= MAX_TABLE_DOCS:
                break

    context_parts = []
    for did in table_doc_ids:
        table_text = render_document_tables(did)
        if table_text:
            context_parts.append(table_text)
    chunk_text = "\n\n".join(h["chunk_text"] for h in hits)
    if chunk_text:
        context_parts.append(chunk_text)
    context = "\n\n".join(context_parts)

    retrieved: list[dict] = [
        {
            "chunk_id": h["id"],
            "document_id": h["document_id"],
            "file_name": h.get("file_name"),
            "similarity": h["similarity"],
            "chunk_index": h.get("chunk_index"),
            "char_start": h.get("char_start"),
            "char_end": h.get("char_end"),
            "page": (h.get("metadata") or {}).get("page"),
        }
        for h in hits
    ]
    # Sources are the source FILE NAMES (downloadable), not document ids.
    sources: list[str] = list({str(h["file_name"]) for h in hits if h.get("file_name")})
    if focus_document_id and not sources:
        sources = store.file_names_for_documents([focus_document_id])

    # Step 3 — generate answer (cap context length for very large documents)
    if len(context) > MAX_CONTEXT_CHARS:
        context = context[:MAX_CONTEXT_CHARS]

    rag_chain = RAG_PROMPT | llm | StrOutputParser()
    answer = await rag_chain.ainvoke({
        "context": context,
        "chat_history": chat_history,
        "question": question,
    })

    # Step 4 — update in-memory history only when not using caller-supplied history.
    if history is None:
        mem = get_history(session_id)
        mem.append(HumanMessage(content=question))
        mem.append(AIMessage(content=answer))
        if len(mem) > 12:
            session_histories[session_id] = mem[-12:]

    return answer, sources, retrieved


async def run_plain_chain(question: str, session_id: str, history: list[dict] | None = None):
    if history is not None:
        chat_history = to_lc_messages(history)[-20:]
    else:
        chat_history = get_history(session_id)

    plain_chain = PLAIN_PROMPT | llm | StrOutputParser()
    answer = await plain_chain.ainvoke({"chat_history": chat_history, "question": question})

    if history is None:
        mem = get_history(session_id)
        mem.append(HumanMessage(content=question))
        mem.append(AIMessage(content=answer))
        if len(mem) > 12:
            session_histories[session_id] = mem[-12:]

    return answer


# ── Routes ─────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok"}


class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"
    source: str | None = None  # focus the chat on a specific uploaded document (legacy)
    history: list[dict] | None = None  # prior messages [{role, content}] for memory
    organization_id: str | None = None  # set => Supabase-backed retrieval
    document_ids: list[str] | None = None  # docs the user may see (None = whole org)
    focus_document_id: str | None = None  # narrow chat to one document (uuid)


class ChatResponse(BaseModel):
    answer: str
    sources: list[str]
    doc_count: int
    chart: dict | None = None  # chart/table spec when the prompt asked for one
    document: dict | None = None  # generated-document info when one was created
    retrieved: list[dict] | None = None  # provenance: [{chunk_id, document_id, similarity}]


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    try:
        # No org context (shouldn't happen from the backend) → plain chat.
        if not req.organization_id:
            answer = await run_plain_chain(req.message, req.session_id, req.history)
            return ChatResponse(answer=answer, sources=[], doc_count=0)

        n_docs = len(req.document_ids or [])

        # Meta/conversational questions ("what was my last question?", "what time
        # is it?") are answered from the chat itself, not the documents — so give a
        # normal answer with NO sources cited.
        if is_meta_question(req.message):
            answer = await run_plain_chain(req.message, req.session_id, req.history)
            return ChatResponse(answer=answer, sources=[], doc_count=0)

        # Generated report/PDF from the accessible/focused documents.
        if wants_document(req.message):
            doc, source_files = await run_document_generation_supabase(
                req.message, req.organization_id, req.document_ids, req.focus_document_id
            )
            answer = (
                f"I've generated **{doc['title']}**. Download it below, "
                "or add it back to my knowledge base."
            )
            return ChatResponse(answer=answer, sources=source_files, doc_count=n_docs, document=doc)

        # Deterministic aggregation over tabular data ("average NO2 by city",
        # "total sales by region"): computed exactly from the stored table so no
        # rows are lost to the context cap and the numbers are precise. Handles
        # both the chart form and the plain-answer form; falls through when the
        # request isn't a (numeric agg BY category) over a table.
        agg = run_aggregation_supabase(
            req.message, req.organization_id, req.document_ids, req.focus_document_id,
            want_chart=wants_chart(req.message) or wants_table(req.message),
        )
        if agg is not None:
            return ChatResponse(
                answer=agg["answer"], sources=agg["sources"], doc_count=n_docs, chart=agg.get("chart")
            )

        # Chart/table from the accessible/focused documents.
        if wants_chart(req.message) or wants_table(req.message):
            try:
                spec, source_files = await run_visualization_supabase(
                    req.message, req.organization_id, req.document_ids, req.focus_document_id
                )
                answer = spec.get("notes") or spec.get("title") or "Here's the chart you asked for."
                # A chart that merely re-plots data the AI already presented (and
                # cited) is just a graphical view of that answer — don't re-cite
                # the same sources for it.
                sources = [] if references_prior_output(req.message) else source_files
                return ChatResponse(answer=answer, sources=sources, doc_count=n_docs, chart=spec)
            except HTTPException:
                pass  # not chartable → fall through to a normal answer

        answer, sources, retrieved = await run_rag_chain(
            req.message,
            req.session_id,
            history=req.history,
            organization_id=req.organization_id,
            document_ids=req.document_ids,
            focus_document_id=req.focus_document_id,
        )
        return ChatResponse(
            answer=answer,
            sources=sources,
            doc_count=len(sources),
            retrieved=retrieved,
        )
    except ChatGoogleGenerativeAIError as e:
        # Surface Gemini quota/rate-limit errors as a clean 429 instead of a 500
        # crash, so the client can show a friendly "try again later" message.
        msg = str(e)
        if "RESOURCE_EXHAUSTED" in msg or "429" in msg:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Gemini quota exceeded for model '{GEMINI_MODEL}'. "
                    "You've hit the free-tier request limit — wait for the quota "
                    "to reset, switch GEMINI_MODEL, or enable billing."
                ),
            )
        raise HTTPException(status_code=502, detail=f"Gemini error: {msg}")


class RetrievePreviewRequest(BaseModel):
    message: str
    organization_id: str
    document_ids: list[str] | None = None  # docs the user may see


# Retrieval-preview thresholds. Cosine similarities from all-MiniLM-L6-v2 are
# not absolutely calibrated (score ranges shift with query wording/length), so
# we filter RELATIVELY to each query's top hit rather than by a fixed cutoff:
#   • REL_MARGIN — keep a doc only if its best chunk is within this of the top
#     doc's best chunk. If the top doc leads the runner-up by more than this,
#     the runner-up is dropped and the answer auto-scopes to the clear winner.
#   • ABS_FLOOR — a low junk guard: drop docs whose best chunk is below this even
#     if they'd survive the relative filter (guards against an all-weak match set).
#   • MAX_PREVIEW_DOCS — never surface more than this many.
# A query is "ambiguous" (→ show the picker) only when 2+ docs survive with
# similar scores; otherwise the client answers directly without a picker step.
PREVIEW_REL_MARGIN = 0.06
PREVIEW_ABS_FLOOR = 0.30
MAX_PREVIEW_DOCS = 4


@app.post("/retrieve-preview")
async def retrieve_preview(req: RetrievePreviewRequest):
    """The documents /chat WOULD draw on for this question: the same scoped
    vector search, stopped before the LLM. Returns the matched documents plus an
    `ambiguous` flag telling the client whether a human still needs to
    disambiguate (several close matches) or one document clearly wins (answer
    straight away). Meta/conversational questions return no documents."""
    if not req.document_ids or is_meta_question(req.message):
        return {"documents": [], "ambiguous": False}

    hits = retrieve_chunks(req.message, req.organization_id, req.document_ids, k=10)

    # Distinct documents, keeping each one's best similarity.
    best: dict[str, float] = {}
    for h in hits:
        did = str(h["document_id"])
        sim = float(h.get("similarity") or 0)
        if did not in best or sim > best[did]:
            best[did] = sim
    if not best:
        return {"documents": [], "ambiguous": False}

    ranked = sorted(best.items(), key=lambda kv: kv[1], reverse=True)
    top_sim = ranked[0][1]
    # Relative filter around the top hit, with an absolute junk floor, then cap.
    kept = [
        (did, sim)
        for did, sim in ranked
        if sim >= PREVIEW_ABS_FLOOR and sim >= top_sim - PREVIEW_REL_MARGIN
    ][:MAX_PREVIEW_DOCS]
    if not kept:
        return {"documents": [], "ambiguous": False}

    names = {str(d["id"]): d.get("file_name") for d in store.documents_by_ids([d for d, _ in kept])}
    documents = [
        {"id": did, "file_name": names.get(did) or "unknown", "similarity": round(sim, 4)}
        for did, sim in kept
        if did in names  # skip ids whose documents row has vanished
    ]
    # Ambiguous only when 2+ close matches remain — embeddings can't tell near
    # duplicates (e.g. "Q2 report" vs "Q3 report") apart, so the user decides.
    ambiguous = len(documents) >= 2
    return {"documents": documents, "ambiguous": ambiguous}


class VisualizeRequest(BaseModel):
    instruction: str
    source: str | None = None  # which uploaded document to chart, by file name
    document_id: str | None = None  # preferred: unambiguous
    # Required to resolve `source` safely — a file name is not unique across tenants.
    organization_id: str | None = None


@app.post("/visualize")
async def visualize(req: VisualizeRequest):
    if not req.source and not req.document_id:
        raise HTTPException(status_code=400, detail="Select a document to chart.")
    try:
        return await run_visualization(
            req.source, req.instruction, req.organization_id, req.document_id
        )
    except ChatGoogleGenerativeAIError as e:
        msg = str(e)
        if "RESOURCE_EXHAUSTED" in msg or "429" in msg:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Gemini quota exceeded for model '{GEMINI_MODEL}'. "
                    "You've hit the free-tier request limit — wait for the quota "
                    "to reset, switch GEMINI_MODEL, or enable billing."
                ),
            )
        raise HTTPException(status_code=502, detail=f"Gemini error: {msg}")


class ExtractMetricsRequest(BaseModel):
    source: str  # which uploaded document to extract dashboard metrics from, by name
    document_id: str | None = None  # preferred: unambiguous
    organization_id: str | None = None  # needed only when resolving by `source`
    custom_metrics: list[dict] = []  # user-defined defs [{key,label,kind,description}]


@app.post("/extract-metrics")
async def extract_metrics_endpoint(req: ExtractMetricsRequest):
    try:
        metrics = await extract_metrics(
            req.source, req.custom_metrics, req.document_id, req.organization_id
        )
        return {"source": req.source, "metrics": metrics}
    except ChatGoogleGenerativeAIError as e:
        msg = str(e)
        if "RESOURCE_EXHAUSTED" in msg or "429" in msg:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Gemini quota exceeded for model '{GEMINI_MODEL}'. "
                    "You've hit the free-tier request limit — wait for the quota "
                    "to reset, switch GEMINI_MODEL, or enable billing."
                ),
            )
        raise HTTPException(status_code=502, detail=f"Gemini error: {msg}")


class GenerateDocRequest(BaseModel):
    instruction: str
    source: str | None = None  # which uploaded document to base the report on
    organization_id: str  # whose bucket the report is written to, and whose docs are read


@app.post("/generate-document")
async def generate_document(req: GenerateDocRequest):
    if not req.source:
        raise HTTPException(status_code=400, detail="Select a document to base the report on.")
    try:
        return await run_document_generation(req.instruction, req.source, req.organization_id)
    except ChatGoogleGenerativeAIError as e:
        msg = str(e)
        if "RESOURCE_EXHAUSTED" in msg or "429" in msg:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Gemini quota exceeded for model '{GEMINI_MODEL}'. "
                    "You've hit the free-tier request limit — wait for the quota "
                    "to reset, switch GEMINI_MODEL, or enable billing."
                ),
            )
        raise HTTPException(status_code=502, detail=f"Gemini error: {msg}")


class IngestRequest(BaseModel):
    filename: str
    document_id: str
    organization_id: str


@app.post("/ingest")
def ingest_document(req: IngestRequest):
    """Index an existing document (e.g. an AI-generated report the user chose to "Add to
    AI") into Supabase under the given document_id, so the AI can answer questions about
    it. The backend has already created the row pointing at the bytes in Storage; we
    resolve them by document_id."""
    path = docstore.resolve_source(req.filename, document_id=req.document_id)
    if path is None:
        raise HTTPException(status_code=404, detail=f"File '{req.filename}' not found")
    store.delete_document_data(req.document_id)  # idempotent re-index
    try:
        result = index_document(req.document_id, req.organization_id, path, req.filename)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"document_id": req.document_id, "filename": req.filename, **result}


# ── Cache eviction ─────────────────────────────────────────────────────────────
# These used to delete the only copy of a file. They no longer delete anything that
# matters: the original lives in Supabase Storage and the documents row cascades to the
# chunks/tables — both the backend's job. All that's left here is dropping our local
# cached copy so we don't serve a stale one, and clearing in-memory chat history.


@app.delete("/documents")
def clear_documents():
    session_histories.clear()
    return {"status": "cleared", "files_removed": docstore.evict()}


@app.delete("/documents/{filename}")
def delete_document(filename: str):
    safe_name = Path(filename).name
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid filename.")
    removed = docstore.evict(safe_name)
    return {"status": "deleted", "filename": safe_name, "file_removed": removed > 0}


@app.delete("/session/{session_id}")
def clear_session(session_id: str):
    session_histories.pop(session_id, None)
    return {"status": "cleared", "session_id": session_id}


# NOTE: there is no /download here any more. Serving a file needs to know WHO is asking —
# this service has no auth context, which is exactly why the old endpoint would hand any
# caller any file it held. Downloads are served by the backend, from Storage, behind an
# access check: GET /api/documents/:id/download.
