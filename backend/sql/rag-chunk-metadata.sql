-- ============================================================================
-- RAG upgrade P1.2 — richer chunk metadata. Run ONCE in the Supabase SQL Editor.
-- Additive + idempotent.
--
-- * organization_id : denormalized onto the chunk so retrieval can filter by
--                     tenant directly (and hybrid search stays a single scan)
--                     instead of always joining to documents.
-- * doc_version     : which version of the document this chunk came from
--                     (documents.version is bumped on re-upload).
-- * token_count     : rough size of the chunk (for budgeting context).
-- * metadata jsonb  : source filename now; page/section/sheet added in Phase 2.
-- ============================================================================

alter table document_chunks add column if not exists organization_id uuid;
alter table document_chunks add column if not exists doc_version int not null default 1;
alter table document_chunks add column if not exists token_count int;
alter table document_chunks add column if not exists metadata jsonb;

alter table documents add column if not exists version int not null default 1;

-- Backfill tenant id on existing chunks from their document.
update document_chunks c
   set organization_id = d.organization_id
  from documents d
 where d.id = c.document_id
   and c.organization_id is null;

-- Direct tenant filter for hybrid / metadata-scoped queries.
create index if not exists idx_document_chunks_org
    on document_chunks (organization_id);
