-- ============================================================================
-- Reconciliation: metric widgets + trash + scope-aware metrics + content dedup.
-- Run ONCE in the Supabase SQL Editor, AFTER personal-dashboards-cleanup.sql.
-- Additive only — nothing is dropped, so it's safe to re-run (idempotent).
-- ============================================================================

-- 1) Trash / restore for ANY widget (metric card or chart). NULL = live,
--    non-null timestamp = in the trash.
alter table dashboard_widgets add column if not exists archived_at timestamptz;

-- 2) Let extracted metric rows be aggregated by document ACCESS at any scope
--    (personal / department / organization), not just by the uploader's user_id.
alter table document_metrics add column if not exists document_id uuid
  references documents(id) on delete cascade;
alter table document_metrics add column if not exists organization_id uuid;

-- Best-effort backfill of pre-existing rows by matching filename -> document.
-- Rows that don't match stay NULL and simply remain personal-scope only.
update document_metrics m
   set document_id = d.id,
       organization_id = d.organization_id
  from documents d
 where d.file_name = m.source_document
   and m.document_id is null;

create index if not exists idx_document_metrics_document_id
  on document_metrics (document_id);

-- 3) User-defined metrics that persist BEFORE any data exists and steer
--    extraction. owner_id is a user / department / organization id per scope.
create table if not exists metric_definitions (
  id              uuid primary key default gen_random_uuid(),
  scope           text not null check (scope in ('PERSONAL','DEPARTMENT','ORGANIZATION')),
  owner_id        uuid not null,
  organization_id uuid not null,
  metric_key      text not null,
  label           text not null,
  description     text,
  kind            text not null default 'number'
    check (kind in ('currency','percent','count','number')),
  created_at      timestamptz not null default now(),
  unique (scope, owner_id, metric_key)
);
-- Match the other app tables: auth is enforced by the backend JWT layer.
alter table metric_definitions disable row level security;

-- 4) Content-hash upload dedup — recognises the SAME file bytes under a
--    DIFFERENT name (filename-only dedup misses that). One per organization.
alter table documents add column if not exists content_hash text;
create unique index if not exists uq_documents_org_content_hash
  on documents (organization_id, content_hash) where content_hash is not null;
