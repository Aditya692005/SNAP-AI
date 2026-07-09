-- ============================================================================
-- SNAP-AI - document_chunks embeddings = vector(384) + the pgvector
-- similarity-search RPC (which returns file_name for downloadable sources).
--
-- Paste the whole file into the Supabase SQL editor. Safe to re-run: the column
-- change is a no-op once it's already vector(384), and the index/function are
-- recreated. If the column is already 384 you can run only part (2) below.
-- ============================================================================

-- 1) Ensure the embedding column is vector(384). The ANN index is bound to the
--    column type, so drop it first, then recreate as HNSW (see rag-hnsw-index.sql).
drop index if exists idx_document_chunks_embedding;

alter table document_chunks
    alter column embedding type vector(384);

create index idx_document_chunks_embedding
    on document_chunks using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);

-- 2) Recreate the search function with the matching 384-dim signature.
--    supabase-js / supabase-py cannot issue `<=>` directly, so retrieval goes
--    through this RPC. Returns the closest chunks by COSINE distance.
--      * p_organization_id - hard tenant boundary (always required)
--      * p_document_ids     - optional uuid[] the caller may see (NULL = whole org)
--    similarity = 1 - cosine_distance (1.0 identical, 0 orthogonal).
-- DROP first: the return type includes file_name, and Postgres won't let CREATE
-- OR REPLACE change an existing function's return columns.
drop function if exists match_document_chunks(vector, uuid, int, uuid[]);

create function match_document_chunks(
    query_embedding   vector(384),
    p_organization_id uuid,
    match_count       int     default 5,
    p_document_ids    uuid[]  default null
)
returns table (
    id          uuid,
    document_id uuid,
    file_name   text,
    chunk_index int,
    chunk_text  text,
    similarity  float,
    char_start  int,
    char_end    int,
    metadata    jsonb
)
language sql
stable
as $$
    select
        dc.id,
        dc.document_id,
        d.file_name,
        dc.chunk_index,
        dc.chunk_text,
        1 - (dc.embedding <=> query_embedding) as similarity,
        dc.char_start,
        dc.char_end,
        dc.metadata
    from document_chunks dc
    join documents d on d.id = dc.document_id
    where d.organization_id = p_organization_id
      and dc.embedding is not null
      and (p_document_ids is null or dc.document_id = any (p_document_ids))
    order by dc.embedding <=> query_embedding
    limit match_count;
$$;