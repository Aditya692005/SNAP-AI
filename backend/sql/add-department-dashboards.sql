-- ============================================================================
-- SNAP-AI — Department dashboards enablement
-- Idempotent. Run AFTER schema.sql (which already defines department_dashboards,
-- organization_dashboards, and dashboard_widgets.department_dashboard_id with the
-- chk_widget_owner constraint). Safe to re-run.
--
-- Adds the two things the department-dashboard feature needs that the base
-- schema lacks:
--   1. a one-default-per-department guard (backs a race-safe get-or-create,
--      mirroring idx_personal_dashboards_one_default for personal boards);
--   2. optimistic-concurrency `version` columns so concurrent edits by multiple
--      managers/admins of the same board/widget are rejected with a conflict
--      instead of silently clobbering each other. Personal widgets keep their
--      last-write-wins behaviour — the version is only enforced on the
--      department (and future organization) dashboard write paths.
--
-- The backend enforces its own JWT auth (not Supabase Auth/RLS); these objects
-- need no RLS policies — the tables they touch already have RLS disabled.
-- ============================================================================

-- 1. One default board per department (race-safe get-or-create).
create unique index if not exists idx_department_dashboards_one_default
  on department_dashboards (department_id) where is_default;

-- 2. Optimistic-concurrency version counters (default 0; bumped on each write).
alter table department_dashboards add column if not exists version integer not null default 0;
alter table dashboard_widgets     add column if not exists version integer not null default 0;
