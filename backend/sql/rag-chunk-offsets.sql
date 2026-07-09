-- ============================================================================
-- RAG upgrade P2.7 — char-offset citations. Run ONCE in the Supabase SQL Editor.
-- Adds the exact character span a chunk occupies within its source block, so a
-- citation can point to (and later highlight) the precise source text. The
-- page/section/block lives in document_chunks.metadata (added in P1.2).
-- Offsets are populated for semantically-chunked prose; NULL for table summaries
-- (LLM-generated, not a verbatim source span) and legacy chunks until re-indexed.
--
-- The match / hybrid RPCs are recreated to return char_start/char_end — apply
-- the updated rpc-match-chunks.sql and rag-hybrid-search.sql after this.
-- ============================================================================

alter table document_chunks add column if not exists char_start int;
alter table document_chunks add column if not exists char_end int;
