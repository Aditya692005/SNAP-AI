-- ============================================================================
-- SNAP-AI - Original document bytes move to Supabase Storage
-- Run AFTER schema.sql. Idempotent: safe to re-run.
--
-- Until now the uploaded file itself lived ONLY on the RAG service's local disk
-- (rag_service/uploads/<filename>). Supabase held the derived data (documents,
-- document_chunks, document_tables) but never the file, and documents.storage_path
-- was hardcoded to `uploads/<filename>` — a path meaningless outside that one
-- container. This makes the bucket the store of record; local disk becomes a
-- disposable cache.
--
-- REQUIRES: SUPABASE_SERVICE_ROLE_KEY in backend/.env and rag_service/.env.
-- The anon key both services use today CANNOT write here: storage.objects has RLS
-- enabled and, unlike the app's own tables, it cannot be disabled on hosted
-- Supabase. That is deliberate — see the policy note below.
-- ============================================================================

-- The bucket ---------------------------------------------------------------------
-- Private (public = false), and intentionally WITHOUT any RLS policies. No policy
-- means no role can reach it except service_role, which bypasses RLS. Adding a
-- policy for `anon` or `authenticated` here would effectively make the bucket
-- world-readable, since the anon key is designed to be shipped to browsers.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- Start fresh ---------------------------------------------------------------------
-- Every existing documents row points at an `uploads/<name>` path with no object
-- behind it, so those documents can no longer be downloaded, charted, or
-- re-extracted. Rather than migrate the stale local files, we drop them and start
-- over (agreed with the user).
--
-- documents cascades to document_chunks / document_tables / document_access. The
-- dashboard metric tables are NOT reachable by that cascade — they key on
-- (user_id, file_name), not document_id — so they must be cleared explicitly or the
-- dashboard keeps showing KPIs sourced from files that no longer exist.
delete from documents;
delete from document_metrics;
delete from document_status;

-- Afterwards, delete the stale files on disk:
--   rag_service/uploads/*     (the 11 orphaned originals)
--   rag_service/chroma_db/    (dead — the vector store moved to pgvector)
