-- User-pinned charts: charts/tables generated in the AI Assistant that the user
-- chose to display on their dashboard. The full chart spec (the same JSON the
-- frontend ChartBlock renders) is stored verbatim so it renders identically.
-- Run this once in the Supabase SQL Editor (Postgres).

create table if not exists dashboard_charts (
  id          bigint generated always as identity primary key,
  user_id     bigint      not null references users(id) on delete cascade,
  title       text,
  spec        jsonb       not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_dashboard_charts_user
  on dashboard_charts (user_id);

-- Backend enforces its own JWT auth (integer user_id), not Supabase Auth/RLS,
-- so RLS must stay off here like the other app tables.
alter table dashboard_charts disable row level security;