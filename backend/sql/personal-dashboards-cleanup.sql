-- ============================================================================
-- SNAP-AI - Personal dashboard widgets cleanup / migration
-- Run once, AFTER schema.sql and add-app-extension-tables.sql.
--
-- Moves the personal dashboard onto the v2 `personal_dashboards` /
-- `dashboard_widgets` tables and open-ended metric extraction:
--   * document_metrics.kind  -> the LLM now emits a value kind per metric
--     (currency|percent|count|number) instead of it being looked up from a
--     hardcoded frontend catalog.
--   * a partial unique index makes getOrCreateDefaultDashboard() race-safe
--     (never two default dashboards for one user).
--   * metric_prefs / dashboard_charts were stopgaps predating dashboard_widgets;
--     the app now stores pinned charts as ai_chart widgets, so these are dropped.
-- ============================================================================

-- Open-ended extraction: store the LLM-proposed value kind per metric.
alter table document_metrics add column if not exists kind text;

-- One default personal dashboard per user (backs the get-or-create pattern).
create unique index if not exists idx_personal_dashboards_one_default
  on personal_dashboards (user_id) where is_default;

-- Retire the pre-widgets stopgap tables (data starts clean on the new model).
drop table if exists metric_prefs;
drop table if exists dashboard_charts;
