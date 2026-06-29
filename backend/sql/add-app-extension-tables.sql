-- ============================================================================
-- SNAP-AI - App-specific extension tables (NOT part of the v2 ERD)
-- Run once, AFTER schema.sql.
--
-- These back features the app ships today that the v2 schema has no home for:
--   * document_metrics / document_status / metric_prefs -> the numeric dashboard
--     extraction pipeline (distinct from the RAG document_chunks/document_tables)
--   * admin_audit -> record of privileged admin actions
--   * dashboard_charts -> AI-generated charts a user pinned to their dashboard
--
-- All user/org FKs are uuid (v2), replacing the old bigint identity columns.
-- The backend enforces its own JWT auth (not Supabase Auth/RLS), so RLS is
-- disabled here to match the rest of the app's tables.
--
-- NOTE: dashboard_charts is a temporary bridge. Phase 4 migrates pinned charts
-- to the v2 `dashboard_widgets` table (config jsonb + ai_message_id); until then
-- the current dashboard reads/writes this table.
-- ============================================================================

-- Dashboard metrics extracted from uploaded documents -------------------------
create table if not exists document_metrics (
  id              uuid             primary key default gen_random_uuid(),
  user_id         uuid             not null references users(id) on delete cascade,
  source_document text             not null,
  metric          text             not null,  -- revenue | sales | profit | expenditure
  department      text,                        -- finance | sales | marketing | hr | operations
  period          text,                        -- YYYY | YYYY-MM | YYYY-Qn (nullable)
  value           double precision not null,
  currency        text,
  category        text,                         -- breakdown dimension (region, dept, ...)
  confidence      double precision,
  created_at      timestamptz      not null default now()
);

create index if not exists idx_document_metrics_user
  on document_metrics (user_id);

-- One row per (user, document): include-in-dashboard flag + extraction status --
create table if not exists document_status (
  user_id         uuid        not null references users(id) on delete cascade,
  source_document text        not null,
  included        boolean     not null default true,
  status          text        not null default 'pending',  -- pending | done | empty | error
  updated_at      timestamptz not null default now(),
  primary key (user_id, source_document)
);

-- Per-user, per-metric display preference -------------------------------------
create table if not exists metric_prefs (
  user_id     uuid        not null references users(id) on delete cascade,
  metric      text        not null,
  visible     boolean     not null default true,
  updated_at  timestamptz not null default now(),
  primary key (user_id, metric)
);

-- Record of privileged admin actions -----------------------------------------
create table if not exists admin_audit (
  id            uuid        primary key default gen_random_uuid(),
  actor_user_id uuid        not null references users(id) on delete cascade,
  action        text        not null,   -- e.g. user.update, department.delete
  target_type   text,                   -- user | department | ...
  target_id     text,
  meta          jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_admin_audit_actor on admin_audit (actor_user_id);

-- Pinned AI-generated charts (the full chart spec is stored verbatim as jsonb) -
create table if not exists dashboard_charts (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references users(id) on delete cascade,
  title       text,
  spec        jsonb       not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_dashboard_charts_user
  on dashboard_charts (user_id);

-- RLS off to match the app's own-JWT auth model -------------------------------
alter table document_metrics disable row level security;
alter table document_status  disable row level security;
alter table metric_prefs     disable row level security;
alter table admin_audit      disable row level security;
alter table dashboard_charts disable row level security;
