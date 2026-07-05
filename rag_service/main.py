"""
RAG microservice — FastAPI + LangChain LCEL + Supabase pgvector + Gemini
Start with: uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""

import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Literal

import markdown
import pandas as pd
from fpdf import FPDF
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from langchain_core.messages import AIMessage, HumanMessage

from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_google_genai.chat_models import ChatGoogleGenerativeAIError
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

import supabase_store as store
from handlers import parse_file

load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
if not GOOGLE_API_KEY:
    raise RuntimeError("GOOGLE_API_KEY is not set in .env")

# Model is configurable so you can switch to one with available quota without
# code changes (each Gemini model has its own free-tier daily request limit).
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

# ── Paths ──────────────────────────────────────────────────────────────────────
UPLOAD_DIR = Path("./uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

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

llm = ChatGoogleGenerativeAI(
    model=GEMINI_MODEL,
    google_api_key=GOOGLE_API_KEY,
    temperature=0.2,
)

splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)

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

    text_blocks = list(parsed.text_chunks)
    for table in parsed.tables:
        store.insert_document_table(document_id, table)
        text_blocks.append(summarize_table(table))

    chunk_texts: list[str] = []
    for block in text_blocks:
        if block and block.strip():
            chunk_texts.extend(splitter.split_text(block))
    chunk_texts = [c for c in chunk_texts if c.strip()]

    if chunk_texts:
        vectors = embeddings.embed_documents(chunk_texts)
        store.insert_document_chunks(document_id, chunk_texts, vectors)

    return {"chunks": len(chunk_texts), "tables": len(parsed.tables)}


@app.post("/index")
async def index_endpoint(
    file: UploadFile = File(...),
    document_id: str = Form(...),
    organization_id: str = Form(...),
):
    """Phase 2 ingestion. The backend creates the documents row (with org + user)
    then posts the file here with its document_id to embed into Supabase."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided.")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported type '{suffix}'. Allowed: {sorted(ALLOWED_EXTENSIONS)}",
        )

    dest = UPLOAD_DIR / file.filename
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

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


def load_dataframe(source: str) -> "pd.DataFrame | None":
    """Re-read the original uploaded file as a DataFrame (CSV / Excel only).

    Charts need accurate numeric data, so for tabular files we parse the source
    on disk rather than relying on the chunked/embedded text. Returns None for
    non-tabular files or if parsing fails.
    """
    safe_name = Path(source).name
    path = (UPLOAD_DIR / safe_name).resolve()
    if UPLOAD_DIR.resolve() not in path.parents or not path.is_file():
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


def build_source_context(source: str | None) -> tuple[str, bool]:
    """Disk-only context for a single uploaded file — used by dashboard metric
    extraction and the standalone /visualize and /generate-document endpoints.
    Tabular files -> CSV text; other types -> extracted text. No vector store."""
    if not source:
        return "", False
    df = load_dataframe(source)
    if df is not None:
        text = "TABULAR DATA (CSV, first rows):\n" + df.head(500).to_csv(index=False)
        return text[:MAX_VIZ_CHARS], True
    safe = Path(source).name
    path = (UPLOAD_DIR / safe).resolve()
    if UPLOAD_DIR.resolve() in path.parents and path.is_file():
        try:
            parsed = parse_file(path)
            text = "DOCUMENT TEXT:\n" + "\n\n".join(parsed.text_chunks)
            return text[:MAX_VIZ_CHARS], False
        except Exception:
            return "", False
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
        ids = rank_documents_by_relevance(instruction, organization_id, document_ids)
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


async def run_visualization(source: str | None, instruction: str) -> dict:
    dataset, is_tabular = build_source_context(source)
    return await _visualize_from_dataset(dataset, is_tabular, instruction, source or "document")


async def run_visualization_supabase(instruction: str, organization_id, document_ids, focus_document_id) -> tuple[dict, list]:
    dataset, is_tabular, used_ids = build_viz_context_supabase(instruction, organization_id, document_ids, focus_document_id)
    source_files = store.file_names_for_documents(used_ids)
    spec = await _visualize_from_dataset(dataset, is_tabular, instruction, "")
    return spec, source_files


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

METRICS_PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "You extract quantitative business metrics from a document for a "
     "dashboard. Return STRICT JSON only: a JSON ARRAY of metric objects, "
     "nothing else.\n\n"
     "Name each metric yourself based on what the document contains - you are "
     "NOT limited to a fixed list. Use a short, generic snake_case key for the "
     "concept (e.g. revenue, marketing_spend, deployment_frequency, "
     "net_promoter_score) and reuse the same key for the same concept across "
     "data points so it aggregates cleanly.\n\n"
     "Each object:\n"
     "{{\n"
     '  "metric": short snake_case key naming the concept,\n'
     '  "department": best-guess domain grouping (finance, sales, marketing, '
     "hr, operations, engineering, ... or a new one if none fit),\n"
     '  "kind": one of "currency","percent","count","number",\n'
     '  "period": "YYYY" | "YYYY-MM" | "YYYY-Qn", or null if none stated,\n'
     '  "value": a plain number (no commas, currency symbols, %, or units),\n'
     '  "currency": ISO code like "USD" if known, else null,\n'
     '  "category": a breakdown label (e.g. region/department/product) or null,\n'
     '  "confidence": 0.0-1.0\n'
     "}}\n\n"
     "Rules:\n"
     "- Use ONLY numbers present in the document; never invent values.\n"
     "- Emit one object per (metric, period, category) data point you find.\n"
     "- For rates/percentages set kind=\"percent\" and emit the plain number "
     "(e.g. 12.5 for 12.5%); for money set kind=\"currency\".\n"
     "- Only extract genuine quantitative metrics; skip prose and identifiers.\n"
     "- If the document contains no such metrics, return [].\n"
     "- Output ONLY the JSON array."),
    ("human", "DOCUMENT:\n{dataset}"),
])


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


async def extract_metrics(source: str) -> list[dict]:
    """Pull canonical financial metrics from one uploaded document."""
    dataset, _ = build_source_context(source)
    if not dataset.strip():
        return []
    chain = METRICS_PROMPT | llm | StrOutputParser()
    raw = await chain.ainvoke({"dataset": dataset})
    try:
        items = parse_json_array(raw)
    except (json.JSONDecodeError, ValueError):
        return []
    metrics = [m for m in (normalize_metric(i) for i in items if isinstance(i, dict)) if m]
    return metrics


# ── Document generation helpers ──────────────────────────────────────────────
# Where generated reports (PDFs) are written. They live alongside uploads so the
# existing /download endpoint can serve them and they can be re-indexed.
GENERATED_DIR = UPLOAD_DIR
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


async def _generate_doc_from_context(context: str, instruction: str, source_label) -> dict:
    if not context.strip():
        raise HTTPException(status_code=400, detail="No document content to work from.")

    chain = DOC_PROMPT | llm | StrOutputParser()
    md_text = await chain.ainvoke({"context": context, "instruction": instruction})

    title = extract_title(md_text)
    filename = f"{slugify(title)}-{datetime.now():%Y%m%d-%H%M%S}.pdf"
    out_path = (GENERATED_DIR / filename).resolve()
    try:
        markdown_to_pdf(md_text, out_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {exc}")

    return {"filename": filename, "title": title, "markdown": md_text, "source": source_label}


async def run_document_generation(instruction: str, source: str | None) -> dict:
    context, _ = build_source_context(source)
    return await _generate_doc_from_context(context, instruction, source)


async def run_document_generation_supabase(instruction: str, organization_id, document_ids, focus_document_id) -> tuple[dict, list]:
    context, used_ids = build_doc_context_supabase(instruction, organization_id, document_ids, focus_document_id)
    source_files = store.file_names_for_documents(used_ids)
    doc = await _generate_doc_from_context(context, instruction, focus_document_id)
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


def retrieve_chunks(question: str, organization_id: str, document_ids=None, k: int = 5) -> list[dict]:
    """Phase 2 retrieval: embed the question and find the nearest chunks via the
    match_document_chunks RPC, scoped to an org and (optionally) a set of
    accessible document ids. Returns the RPC rows."""
    query_vec = embeddings.embed_query(question)
    return store.match_chunks(query_vec, organization_id, document_ids=document_ids, match_count=k)

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
        {"chunk_id": h["id"], "document_id": h["document_id"], "similarity": h["similarity"]}
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
    source: str | None = None  # which uploaded document to chart


@app.post("/visualize")
async def visualize(req: VisualizeRequest):
    if not req.source:
        raise HTTPException(status_code=400, detail="Select a document to chart.")
    try:
        return await run_visualization(req.source, req.instruction)
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
    source: str  # which uploaded document to extract dashboard metrics from


@app.post("/extract-metrics")
async def extract_metrics_endpoint(req: ExtractMetricsRequest):
    try:
        metrics = await extract_metrics(req.source)
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


@app.post("/generate-document")
async def generate_document(req: GenerateDocRequest):
    if not req.source:
        raise HTTPException(status_code=400, detail="Select a document to base the report on.")
    try:
        return await run_document_generation(req.instruction, req.source)
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
    filename: str  # a file already present in the uploads/generated directory
    document_id: str
    organization_id: str


@app.post("/ingest")
def ingest_document(req: IngestRequest):
    """Index a file already on disk (e.g. a generated report) into Supabase under
    the given document_id, so the AI can answer questions about it."""
    safe_name = Path(req.filename).name
    path = (UPLOAD_DIR / safe_name).resolve()
    if UPLOAD_DIR.resolve() not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail=f"File '{safe_name}' not found")
    store.delete_document_data(req.document_id)  # idempotent re-index
    try:
        result = index_document(req.document_id, req.organization_id, path, safe_name)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"document_id": req.document_id, "filename": safe_name, **result}


@app.delete("/documents")
def clear_documents():
    """Clear the on-disk uploads/generated files + in-memory chat history. The
    Supabase chunks/tables are removed by the backend (documents cascade)."""
    session_histories.clear()
    removed = 0
    for path in UPLOAD_DIR.iterdir():
        if path.is_file():
            try:
                path.unlink()
                removed += 1
            except OSError:
                pass
    return {"status": "cleared", "files_removed": removed}


@app.delete("/documents/{filename}")
def delete_document(filename: str):
    """Delete a single document's on-disk file. Its Supabase chunks/tables are
    removed by the backend (documents cascade)."""
    safe_name = Path(filename).name
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid filename.")

    file_removed = False
    path = (UPLOAD_DIR / safe_name).resolve()
    if UPLOAD_DIR.resolve() in path.parents and path.is_file():
        try:
            path.unlink()
            file_removed = True
        except OSError:
            pass

    return {"status": "deleted", "filename": safe_name, "file_removed": file_removed}


@app.delete("/session/{session_id}")
def clear_session(session_id: str):
    session_histories.pop(session_id, None)
    return {"status": "cleared", "session_id": session_id}


@app.get("/download/{filename}")
def download_document(filename: str):
    # Resolve against UPLOAD_DIR and reject anything that escapes it (path traversal).
    safe_name = Path(filename).name
    file_path = (UPLOAD_DIR / safe_name).resolve()
    if UPLOAD_DIR.resolve() not in file_path.parents or not file_path.is_file():
        raise HTTPException(status_code=404, detail=f"File '{safe_name}' not found")
    return FileResponse(
        path=str(file_path),
        filename=safe_name,
        media_type="application/octet-stream",
    )
