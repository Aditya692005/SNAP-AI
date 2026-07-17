"""Supabase access for the RAG pipeline: write document_chunks / document_tables
and run vector similarity search via the match_document_chunks RPC.

Embeddings are stored in the vector(384) column. PostgREST needs the vector as
its text literal ("[0.1,0.2,...]"), so we format lists that way on the way in.

Re-indexing is versioned: the new version's rows are inserted FIRST, then the
old version is retired (chunks soft-superseded so cited chunk ids still
resolve; table rows deleted). Queries never see an empty document mid-reindex.
"""

import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from supabase import create_client

# Load .env before any client is created (create_client only reads env lazily in
# sb(), so importing supabase first is fine).
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

_client = None


def sb():
    """Shared Supabase client.

    Prefers the SERVICE_ROLE key. The app's own tables run with RLS disabled, so the
    anon key is enough for them — but Storage is not: storage.objects has RLS on and it
    cannot be disabled on hosted Supabase, so the private `documents` bucket (where the
    original uploaded files now live) is unreachable without service_role. Falls back to
    the anon key so a deployment that hasn't set the new var yet still serves chat and
    search; only the file-fetching paths break.
    """
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.environ["SUPABASE_KEY"]
        # Bound every PostgREST call so a slow/unreachable Supabase can't pile
        # up requests indefinitely. Falls back to defaults on older clients.
        try:
            try:
                from supabase.lib.client_options import SyncClientOptions as _Options
            except ImportError:
                from supabase.lib.client_options import ClientOptions as _Options
            timeout = int(os.getenv("SUPABASE_TIMEOUT_SECONDS", "15"))
            _client = create_client(
                url, key, options=_Options(postgrest_client_timeout=timeout)
            )
        except Exception:
            _client = create_client(url, key)
    return _client


def _vec(embedding) -> str:
    """List[float] -> pgvector text literal."""
    return "[" + ",".join(repr(float(x)) for x in embedding) + "]"


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def storage_path_for(
    document_id: str | None = None,
    file_name: str | None = None,
    organization_id: str | None = None,
) -> tuple[str, str] | None:
    """Locate a document's ORIGINAL bytes: -> (storage_path, file_name), or None.

    By `document_id` when we have it — exact, and the only unambiguous way. Otherwise by
    file name, which callers that only remember a name (a pinned chart, a cited source)
    must fall back to; that lookup MUST be scoped by organization_id, because a file name
    is not unique across tenants and resolving one without an org would happily hand back
    a different company's document. Newest wins when a name repeats within an org.
    """
    q = sb().table("documents").select("storage_path, file_name")
    if document_id:
        q = q.eq("id", document_id)
    elif file_name:
        q = q.eq("file_name", file_name)
        if organization_id:
            q = q.eq("organization_id", organization_id)
        q = q.order("created_at", desc=True)
    else:
        return None

    res = q.limit(1).execute()
    rows = res.data or []
    if not rows or not rows[0].get("storage_path"):
        return None
    return rows[0]["storage_path"], rows[0].get("file_name") or (file_name or "")


def insert_document_table(document_id: str, table, doc_version: int = 1) -> None:
    row = {
        "document_id": document_id,
        "sheet_name": table.sheet_name,
        "table_name": table.table_name,
        "table_data": {"rows": table.rows},
        "table_index": table.table_index,
        "heading_context": table.heading_context,
        "doc_version": doc_version,
    }
    try:
        sb().table("document_tables").insert(row).execute()
    except Exception:
        # doc_version column not deployed yet (rag-scale-hardening.sql).
        row.pop("doc_version", None)
        sb().table("document_tables").insert(row).execute()


def get_document_version(document_id: str) -> int:
    """Current version of a document (bumped on re-upload). 1 if unknown or the
    `version` column isn't deployed yet."""
    try:
        res = sb().table("documents").select("version").eq("id", document_id).limit(1).execute()
        data = res.data or []
        if data and data[0].get("version") is not None:
            return int(data[0]["version"])
    except Exception:
        pass
    return 1


def get_max_chunk_version(document_id: str) -> int:
    """Highest doc_version among a document's existing chunks (0 = none). Used
    so re-indexing always writes a strictly newer version even if the backend
    didn't bump documents.version."""
    try:
        res = (
            sb().table("document_chunks").select("doc_version")
            .eq("document_id", document_id)
            .order("doc_version", desc=True).limit(1).execute()
        )
        data = res.data or []
        if data and data[0].get("doc_version") is not None:
            return int(data[0]["doc_version"])
        if data:
            return 1  # chunks exist but predate the doc_version column
    except Exception:
        pass
    return 0


def set_document_status(document_id: str, status: str, error=None) -> None:
    """Update documents.status (and processing_error) — the background index
    job owns the document's lifecycle. Best-effort with pre-migration
    fallbacks: never raises."""
    update: dict = {"status": status}
    if error is not None:
        update["processing_error"] = str(error)[:2000]
    elif status == "PROCESSED":
        update["processing_error"] = None
    attempts = [update]
    if "processing_error" in update:
        attempts.append({"status": status})  # processing_error column missing
    if status == "FAILED":
        attempts.append({"status": "UPLOADED"})  # 'FAILED' not in check constraint yet
    for payload in attempts:
        try:
            sb().table("documents").update(payload).eq("id", document_id).execute()
            return
        except Exception:
            continue
    print(f"[rag] could not set status={status} for document {document_id}")


def insert_document_chunks(
    document_id: str,
    texts: list[str],
    embeddings: list,
    *,
    organization_id: str | None = None,
    doc_version: int = 1,
    source: str | None = None,
    metas: list[dict] | None = None,
    start_index: int = 0,
) -> int:
    """Insert chunks with tenant id + version + rough token count + metadata +
    char offsets. `metas[i]` (optional, parallel to texts) may carry
    {char_start, char_end, page} for chunk i; page/section go into metadata jsonb
    alongside the source filename, offsets into their own columns.
    token_count is a cheap ~chars/4 estimate. Falls back to the minimal column
    set if the P1.2/P2.7 migrations aren't applied yet, so ingestion never
    hard-breaks on a migration lag."""
    metas = metas or []
    rows = []
    for i, (text, emb) in enumerate(zip(texts, embeddings)):
        meta = metas[i] if i < len(metas) else {}
        md = {"source": source} if source else {}
        if meta.get("page") is not None:
            md["page"] = meta["page"]
        rows.append({
            "document_id": document_id,
            "organization_id": organization_id,
            "chunk_index": start_index + i,
            "chunk_text": text,
            "embedding": _vec(emb),
            "doc_version": doc_version,
            "token_count": max(1, len(text) // 4),
            "metadata": md or None,
            "char_start": meta.get("char_start"),
            "char_end": meta.get("char_end"),
        })
    if not rows:
        return 0
    try:
        sb().table("document_chunks").insert(rows).execute()
    except Exception as exc:
        # Loud, not silent: chunks inserted this way have NO organization_id, so
        # tenant-filtered retrieval cannot see them until the migrations run.
        print(
            "[rag] FULL-METADATA CHUNK INSERT FAILED — falling back to minimal "
            f"columns (chunks will be invisible to org-scoped search): {exc}. "
            "Apply rag-chunk-metadata.sql / rag-chunk-offsets.sql / "
            "rag-scale-hardening.sql."
        )
        minimal = [
            {"document_id": r["document_id"], "chunk_index": r["chunk_index"],
             "chunk_text": r["chunk_text"], "embedding": r["embedding"]}
            for r in rows
        ]
        sb().table("document_chunks").insert(minimal).execute()
    return len(rows)


def supersede_old_versions(document_id: str, current_version: int, before_iso: str) -> None:
    """Retire everything older than `current_version` AFTER the new version is
    fully inserted: chunks are soft-superseded (rows kept so chunk ids cited in
    old chat messages still resolve; retrieval filters them out), table rows are
    deleted (they feed answers, not citations). `before_iso` is the indexing
    start time — the pre-migration fallback uses created_at < before_iso so it
    can never touch the rows just inserted."""
    try:
        (
            sb().table("document_chunks")
            .update({"superseded_at": _utcnow_iso()})
            .eq("document_id", document_id)
            .lt("doc_version", current_version)
            .is_("superseded_at", "null")
            .execute()
        )
    except Exception:
        try:  # superseded_at/doc_version not deployed → legacy hard delete of old rows
            sb().table("document_chunks").delete() \
                .eq("document_id", document_id).lt("created_at", before_iso).execute()
        except Exception:
            pass
    try:
        sb().table("document_tables").delete() \
            .eq("document_id", document_id).lt("doc_version", current_version).execute()
    except Exception:
        try:
            sb().table("document_tables").delete() \
                .eq("document_id", document_id).lt("created_at", before_iso).execute()
        except Exception:
            pass


def delete_version(document_id: str, version: int) -> None:
    """Remove one version's chunks + tables — cleanup after a failed re-index,
    so a partial new version never becomes retrievable."""
    for table in ("document_chunks", "document_tables"):
        try:
            sb().table(table).delete() \
                .eq("document_id", document_id).eq("doc_version", version).execute()
        except Exception:
            pass


def hybrid_match_chunks(query_embedding, query_text: str, organization_id: str, document_ids=None, match_count: int = 30) -> list[dict]:
    """Hybrid dense + full-text search via the RRF-fusing RPC. Returns rows with
    {id, document_id, file_name, chunk_index, chunk_text, similarity, fts_rank,
    score}. Raises if the P1.3 migration (function/tsv column) isn't applied —
    callers fall back to dense-only match_chunks."""
    params = {
        "query_embedding": _vec(query_embedding),
        "query_text": query_text or "",
        "p_organization_id": organization_id,
        "match_count": match_count,
        "p_document_ids": document_ids,
    }
    res = sb().rpc("hybrid_match_document_chunks", params).execute()
    return res.data or []


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
    """Live (non-superseded) text chunks for a set of documents (report context)."""
    if not document_ids:
        return []

    def q():
        return (
            sb()
            .table("document_chunks")
            .select("document_id, chunk_index, chunk_text")
            .in_("document_id", document_ids)
            .order("chunk_index")
            .limit(limit)
        )

    try:
        res = q().is_("superseded_at", "null").execute()
    except Exception:  # superseded_at not deployed yet
        res = q().execute()
    return res.data or []


def chunks_for_document(document_id: str) -> list[dict]:
    def q():
        return (
            sb()
            .table("document_chunks")
            .select("chunk_index, chunk_text")
            .eq("document_id", document_id)
            .order("chunk_index")
        )

    try:
        res = q().is_("superseded_at", "null").execute()
    except Exception:
        res = q().execute()
    return res.data or []


def delete_document_data(document_id: str) -> None:
    """Remove ALL of a document's chunks + tables (document deletion)."""
    sb().table("document_chunks").delete().eq("document_id", document_id).execute()
    sb().table("document_tables").delete().eq("document_id", document_id).execute()
