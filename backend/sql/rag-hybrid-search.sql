-- ============================================================================
-- RAG upgrade P1.3 — hybrid retrieval: dense vectors + Postgres full-text
-- search, fused with Reciprocal Rank Fusion. Run ONCE in the Supabase SQL
-- Editor, AFTER rag-chunk-metadata.sql (needs document_chunks.organization_id).
-- Everything stays in Postgres — no new infrastructure.
-- ============================================================================

-- 1) Full-text vector over chunk_text + GIN index for keyword search.
alter table document_chunks
    add column if not exists tsv tsvector
    generated always as (to_tsvector('english', coalesce(chunk_text, ''))) stored;

create index if not exists idx_document_chunks_tsv
    on document_chunks using gin (tsv);

-- 2) Hybrid search RPC. Takes the query BOTH as an embedding (dense) and as raw
--    text (FTS). Ranks each independently, fuses by RRF (score = sum 1/(k+rank),
--    k=60), returns the top match_count. Tenant filter uses the denormalized
--    document_chunks.organization_id; documents is joined only for file_name.
drop function if exists hybrid_match_document_chunks(vector, text, uuid, int, uuid[]);

create function hybrid_match_document_chunks(
    query_embedding   vector(384),
    query_text        text,
    p_organization_id uuid,
    match_count       int    default 30,
    p_document_ids    uuid[] default null
)
returns table (
    id          uuid,
    document_id uuid,
    file_name   text,
    chunk_index int,
    chunk_text  text,
    similarity  float,
    fts_rank    float,
    score       float,
    char_start  int,
    char_end    int,
    metadata    jsonb
)
language sql
stable
as $$
    with q as (
        select websearch_to_tsquery('english', coalesce(query_text, '')) as tsq
    ),
    dense as (
        select dc.id,
               row_number() over (order by dc.embedding <=> query_embedding) as rnk,
               1 - (dc.embedding <=> query_embedding) as sim
        from document_chunks dc
        where dc.organization_id = p_organization_id
          and dc.embedding is not null
          and (p_document_ids is null or dc.document_id = any (p_document_ids))
        order by dc.embedding <=> query_embedding
        limit match_count * 2
    ),
    fts as (
        select dc.id,
               row_number() over (order by ts_rank(dc.tsv, q.tsq) desc) as rnk,
               ts_rank(dc.tsv, q.tsq) as frank
        from document_chunks dc, q
        where dc.organization_id = p_organization_id
          and q.tsq is not null
          and dc.tsv @@ q.tsq
          and (p_document_ids is null or dc.document_id = any (p_document_ids))
        order by ts_rank(dc.tsv, q.tsq) desc
        limit match_count * 2
    ),
    fused as (
        select coalesce(dense.id, fts.id) as id,
               coalesce(1.0 / (60 + dense.rnk), 0) + coalesce(1.0 / (60 + fts.rnk), 0) as score,
               coalesce(dense.sim, 0) as similarity,
               coalesce(fts.frank, 0) as fts_rank
        from dense
        full outer join fts on dense.id = fts.id
    )
    select f.id, dc.document_id, d.file_name, dc.chunk_index, dc.chunk_text,
           f.similarity, f.fts_rank, f.score, dc.char_start, dc.char_end, dc.metadata
    from fused f
    join document_chunks dc on dc.id = f.id
    join documents d on d.id = dc.document_id
    order by f.score desc
    limit match_count;
$$;
