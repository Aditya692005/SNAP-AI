-- ============================================================================
-- Phase 3 migration: persist AI-chat extras per message.
-- Run once in the Supabase SQL Editor on a database created before Phase 3.
-- (Fresh databases get this column from schema.sql directly.)
--
-- ai_messages.metadata holds what the v2 columns can't: the assistant reply's
-- cited sources, a chart/table spec, or generated-document info, e.g.
--   { "sources": ["q3.csv"], "chart": {...}, "document": {...} }
-- ============================================================================

alter table ai_messages
    add column if not exists metadata jsonb;
