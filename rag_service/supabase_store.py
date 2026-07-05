"""Supabase access for the RAG pipeline: write document_chunks / document_tables
and run vector similarity search via the match_document_chunks RPC.

Embeddings are stored in the vector(384) column. PostgREST needs the vector as
its text literal ("[0.1,0.2,...]"), so we format lists that way on the way in.
"""

import os

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from supabase import create_client

_client = None


def sb():
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_KEY"]
        _client = create_client(url, key)
    return _client


def _vec(embedding) -> str:
    """List[float] -> pgvector text literal."""
    return "[" + ",".join(repr(float(x)) for x in embedding) + "]"


def insert_document_table(document_id: str, table) -> None:
    sb().table("document_tables").insert(
        {
            "document_id": document_id,
            "sheet_name": table.sheet_name,
            "table_name": table.table_name,
            "table_data": {"rows": table.rows},
            "table_index": table.table_index,
            "heading_context": table.heading_context,
        }
    ).execute()


def insert_document_chunks(document_id: str, texts: list[str], embeddings: list, start_index: int = 0) -> int:
    rows = [
        {
            "document_id": document_id,
            "chunk_index": start_index + i,
            "chunk_text": text,
            "embedding": _vec(emb),
        }
        for i, (text, emb) in enumerate(zip(texts, embeddings))
    ]
    if rows:
        sb().table("document_chunks").insert(rows).execute()
    return len(rows)


def match_chunks(query_embedding, organization_id: str, document_ids=None, match_count: int = 5) -> list[dict]:
    """Cosine-similarity search via the RPC, scoped to an org and (optionally) a
    set of accessible document ids. Returns a list of {id, document_id,
    chunk_index, chunk_text, similarity}."""
    params = {
        "query_embedding": _vec(query_embedding),
        "p_organization_id": organization_id,
        "match_count": match_count,
        "p_document_ids": document_ids,  # None => search the whole org
    }
    res = sb().rpc("match_document_chunks", params).execute()
    return res.data or []


def file_names_for_documents(document_ids) -> list[str]:
    """Distinct file names for a set of document ids (for citing sources)."""
    if not document_ids:
        return []
    res = sb().table("documents").select("file_name").in_("id", document_ids).execute()
    return list({str(r["file_name"]) for r in (res.data or []) if r.get("file_name")})


def documents_by_ids(document_ids) -> list[dict]:
    """[{id, file_name}] rows for a set of document ids (retrieval preview)."""
    if not document_ids:
        return []
    res = sb().table("documents").select("id, file_name").in_("id", document_ids).execute()
    return res.data or []


def tables_for_documents(document_ids) -> list[dict]:
    """Stored tabular data for a set of documents (for accurate chart data)."""
    if not document_ids:
        return []
    res = (
        sb()
        .table("document_tables")
        .select("document_id, sheet_name, table_name, table_data, table_index")
        .in_("document_id", document_ids)
        .order("table_index")
        .execute()
    )
    return res.data or []


def chunks_for_documents(document_ids, limit: int = 200) -> list[dict]:
    """Text chunks for a set of documents (for report context)."""
    if not document_ids:
        return []
    res = (
        sb()
        .table("document_chunks")
        .select("document_id, chunk_index, chunk_text")
        .in_("document_id", document_ids)
        .order("chunk_index")
        .limit(limit)
        .execute()
    )
    return res.data or []


def chunks_for_document(document_id: str) -> list[dict]:
    res = (
        sb()
        .table("document_chunks")
        .select("chunk_index, chunk_text")
        .eq("document_id", document_id)
        .order("chunk_index")
        .execute()
    )
    return res.data or []


def delete_document_data(document_id: str) -> None:
    """Remove a document's chunks + tables (e.g. before re-indexing)."""
    sb().table("document_chunks").delete().eq("document_id", document_id).execute()
    sb().table("document_tables").delete().eq("document_id", document_id).execute()
