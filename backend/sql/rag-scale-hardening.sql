-- ============================================================================
-- RAG upgrade P3 — scale hardening. Run ONCE in the Supabase SQL Editor.
-- Additive + idempotent. AFTER this file, re-run rpc-match-chunks.sql and
-- rag-hybrid-search.sql (both updated to filter superseded chunks and tune
-- HNSW recall).
--
-- * document_chunks.superseded_at — re-indexing now inserts the new version's
--   chunks FIRST, then soft-retires the old version (instead of delete-then-
--   insert). Queries never hit an empty window mid-reindex, and chunk ids
--   cited in old chat messages still resolve.
-- * document_tables.doc_version — lets re-indexing tell old table rows from
--   the new version's, so old rows are dropped only after the new ones exist.
-- * documents 'FAILED' status + processing_error — indexing now runs as a
--   background job; failures must be visible instead of a row stuck in
--   PROCESSING forever.
-- ============================================================================

-- 1) Soft-supersede for chunk versions (citation-stable re-indexing).
alter table document_chunks add column if not exists superseded_at timestamptz;

-- Retrieval always filters superseded_at is null; partial index keeps the
-- live-chunk scans cheap as superseded versions accumulate.
create index if not exists idx_document_chunks_live
    on document_chunks (document_id)
    where superseded_at is null;

-- 2) Version tag on stored tables (insert-new-then-delete-old re-indexing).
alter table document_tables add column if not exists doc_version int not null default 1;

-- 3) Background-indexing status. The original check constraint only allowed
--    UPLOADED/PROCESSING/PROCESSED; async ingestion needs a terminal failure
--    state plus the error message that caused it.
alter table documents drop constraint if exists documents_status_check;
alter table documents add constraint documents_status_check
    check (status in ('UPLOADED', 'PROCESSING', 'PROCESSED', 'FAILED'));

alter table documents add column if not exists processing_error text;

-- 4) HNSW recall tuning, database-wide. The org/document filters in the search
--    RPCs are applied AFTER the HNSW scan, so a small tenant in a big
--    multi-tenant table needs a wider candidate pool (default ef_search = 40)
--    to keep recall.
--
--    Why this shape: hnsw.ef_search is an EXTENSION parameter — until
--    pgvector's shared library is loaded in the session it's an unknown
--    "placeholder" GUC, and setting one of those needs superuser (hence the
--    42501 a plain `set hnsw.ef_search` / function-level SET clause can throw
--    on Supabase). So: force the library to load first (any vector cast does
--    it), THEN persist the setting at the database level as the db owner.
--    Applies to new connections; PostgREST's pool picks it up as it recycles.
--    Best-effort — if the role can't alter the database, keep the default.
do $$
begin
    perform '[1]'::vector;  -- load pgvector so hnsw.ef_search is a known GUC
    execute format('alter database %I set hnsw.ef_search = 100', current_database());
    raise notice 'hnsw.ef_search default set to 100 for database %', current_database();

    -- pgvector >= 0.8 only: keep scanning until enough filter-passing rows are
    -- found, instead of returning fewer results for heavily-filtered tenants.
    begin
        execute format(
            'alter database %I set hnsw.iterative_scan = relaxed_order', current_database()
        );
        raise notice 'hnsw.iterative_scan = relaxed_order enabled';
    exception when others then
        raise notice 'hnsw.iterative_scan unavailable (pgvector < 0.8) — skipped';
    end;
exception when others then
    raise notice 'could not raise hnsw.ef_search (%) — keeping the default of 40', sqlerrm;
end $$;