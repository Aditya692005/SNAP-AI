-- ============================================================================
-- SNAP-AI - Move document_chunks embeddings to vector(384) + recreate the
-- pgvector similarity-search RPC. Safe to run while document_chunks is empty.
-- ============================================================================

-- 1) Resize the embedding column (the ivfflat index must be dropped first,
--    since it's bound to the column type).
drop index if exists idx_document_chunks_embedding;

alter table document_chunks
    alter column embedding type vector(384);


-- 1) Resize the embedding column (the ivfflat index must be dropped first,
--    since it's bound to the column type).
drop index if exists idx_document_chunks_embedding;

alter table document_chunks
    alter column embedding type vector(384);

create index idx_document_chunks_embedding
    on document_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- 2) Recreate the search function with the matching 384-dim signature.
--    supabase-js / supabase-py cannot issue `<=>` directly, so retrieval goes
--    through this RPC. Returns the closest chunks by COSINE distance.
--      * p_organization_id - hard tenant boundary (always required)
--      * p_document_ids     - optional uuid[] the caller may see (NULL = whole org)
--    similarity = 1 - cosine_distance (1.0 identical, 0 orthogonal).
create or replace function match_document_chunks(
    query_embedding   vector(384),
    p_organization_id uuid,
    match_count       int     default 5,
    p_document_ids    uuid[]  default null
)
returns table (
    id          uuid,
    document_id uuid,
    chunk_index int,
    chunk_text  text,
    similarity  float
)
language sql
stable
as $$
    select
        dc.id,
        dc.document_id,
        dc.chunk_index,
        dc.chunk_text,
        1 - (dc.embedding <=> query_embedding) as similarity
    from document_chunks dc
    join documents d on d.id = dc.document_id
    where d.organization_id = p_organization_id
      and dc.embedding is not null
      and (p_document_ids is null or dc.document_id = any (p_document_ids))
    order by dc.embedding <=> query_embedding
    limit match_count;
$$;