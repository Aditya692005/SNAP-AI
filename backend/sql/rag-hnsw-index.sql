    -- ============================================================================
    -- RAG upgrade P1.1 — swap the embedding ANN index from ivfflat to HNSW.
    -- Run ONCE in the Supabase SQL Editor. Requires pgvector >= 0.5.0 (Supabase OK).
    --
    -- Why: ivfflat with the default probes=1 has poor recall and its `lists` need
    -- retuning as the table grows. HNSW gives better recall/latency out of the box,
    -- needs no list tuning, and the existing `<=>` cosine ordering in
    -- match_document_chunks uses it transparently (no app change).
    --
    -- Query-time recall/latency is governed by hnsw.ef_search (default 40); raise it
    -- per session with `set hnsw.ef_search = 80;` if you want higher recall.
    -- ============================================================================

    drop index if exists idx_document_chunks_embedding;

    create index idx_document_chunks_embedding
        on document_chunks using hnsw (embedding vector_cosine_ops)
        with (m = 16, ef_construction = 64);
