-- Department-specific metrics upgrade.
-- 1) Tags each extracted metric with the department it belongs to.
-- 2) Lets each user choose which metrics are *displayed* on their dashboard,
--    independently of extraction (metrics keep updating from uploads either way).
-- Run this once in the Supabase SQL Editor (Postgres), after add-dashboard-metrics.sql.

-- Department of the metric (finance | sales | marketing | hr | operations).
alter table document_metrics
  add column if not exists department text;

-- Per-user, per-metric display preference. A missing row means "use the app
-- default" (the original four metrics are shown, the rest hidden until enabled).
create table if not exists metric_prefs (
  user_id     bigint      not null references users(id) on delete cascade,
  metric      text        not null,
  visible     boolean     not null default true,
  updated_at  timestamptz not null default now(),
  primary key (user_id, metric)
);

-- Backend enforces its own JWT auth (integer user_id), not Supabase Auth/RLS,
-- so RLS must stay off here like the other app tables.
alter table metric_prefs disable row level security;
