-- Dashboard metrics: financial figures extracted from uploaded documents, plus
-- per-document settings (include/exclude toggle + extraction status).
-- Run this once in the Supabase SQL Editor (Postgres).

create table if not exists document_metrics (
  id              bigint generated always as identity primary key,
  user_id         bigint           not null references users(id) on delete cascade,
  source_document text             not null,
  metric          text             not null,  -- revenue | sales | profit | expenditure
  period          text,                        -- YYYY | YYYY-MM | YYYY-Qn (nullable)
  value           double precision not null,
  currency        text,
  category        text,                         -- breakdown dimension (region, dept, …)
  confidence      double precision,
  created_at      timestamptz      not null default now()
);

create index if not exists idx_document_metrics_user
  on document_metrics (user_id);

-- One row per (user, document): whether it feeds the dashboard, and the state of
-- its metric extraction.
create table if not exists document_status (
  user_id         bigint      not null references users(id) on delete cascade,
  source_document text        not null,
  included        boolean     not null default true,
  status          text        not null default 'pending',  -- pending | done | empty | error
  updated_at      timestamptz not null default now(),
  primary key (user_id, source_document)
);

-- This app enforces auth in the backend (its own JWT + integer user_id), not via
-- Supabase Auth/RLS, so RLS must be off or all writes are rejected (42501) —
-- matching how the existing `users` table is accessed.
alter table document_metrics disable row level security;
alter table document_status  disable row level security;
