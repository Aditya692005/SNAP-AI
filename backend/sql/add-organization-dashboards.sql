-- ============================================================================
-- SNAP-AI — Organization dashboard enablement
-- Idempotent. Run AFTER schema.sql (which already defines organization_dashboards
-- and dashboard_widgets.organization_dashboard_id with the chk_widget_owner
-- constraint) and add-department-dashboards.sql. Safe to re-run.
--
-- Mirrors add-department-dashboards.sql, one scope up: a single shared board per
-- ORGANIZATION that everyone with VIEW_ORGANIZATION_DASHBOARD sees and that
-- org admins / MANAGE_ORGANIZATION_DASHBOARD holders edit. Adds:
--   1. a one-default-per-organization guard (backs a race-safe get-or-create);
--   2. an optimistic-concurrency `version` column so concurrent admin edits are
--      rejected with a conflict instead of silently clobbering each other.
--
-- The backend enforces its own JWT auth (not Supabase Auth/RLS); these objects
-- need no RLS policies — the tables they touch already have RLS disabled.
-- ============================================================================

-- 1. One default board per organization (race-safe get-or-create).
create unique index if not exists idx_organization_dashboards_one_default
  on organization_dashboards (organization_id) where is_default;

-- 2. Optimistic-concurrency version counter (default 0; bumped on each write).
alter table organization_dashboards add column if not exists version integer not null default 0;
