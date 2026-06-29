-- ============================================================================
-- SNAP-AI - pgvector similarity-search RPC
-- Run once, AFTER schema.sql.
--
-- supabase-js / supabase-py cannot issue the `<=>` operator directly, so RAG
-- retrieval goes through this function via supabase.rpc('match_document_chunks',
-- {...}). It returns the closest chunks by COSINE distance, matching the
-- vector_cosine_ops ivfflat index on document_chunks.embedding.
--
-- Scoping:
--   * p_organization_id  - hard tenant boundary (always required).
--   * p_document_ids      - optional uuid[] of documents the caller is allowed to
--                           see (computed in the backend from document_access).
--                           Pass NULL to search every document in the org.
--
-- `similarity` is returned as 1 - cosine_distance (1.0 = identical, 0 = orthogonal).
-- ============================================================================

create or replace function match_document_chunks(
    query_embedding   vector(768),
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