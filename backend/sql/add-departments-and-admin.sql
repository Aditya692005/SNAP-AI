-- Phase 1 + Admin foundation:
--   * departments (org structure)
--   * users.department_id + users.deactivated_at (soft delete)
--   * admin_audit (record of privileged actions)
-- Run once in the Supabase SQL Editor (Postgres).

-- ── Departments ───────────────────────────────────────────────────────────────
create table if not exists departments (
  id   bigint generated always as identity primary key,
  key  text not null unique,          -- finance | sales | marketing | hr | operations | ...
  name text not null
);

insert into departments (key, name) values
  ('finance', 'Finance'),
  ('sales', 'Sales'),
  ('marketing', 'Marketing'),
  ('hr', 'Human Resources'),
  ('operations', 'Operations')
on conflict (key) do nothing;

-- ── Users: department + soft-delete ───────────────────────────────────────────
alter table users add column if not exists department_id  bigint references departments(id);
alter table users add column if not exists deactivated_at timestamptz;

create index if not exists idx_users_department on users (department_id);

-- ── Admin audit log ───────────────────────────────────────────────────────────
create table if not exists admin_audit (
  id            bigint generated always as identity primary key,
  actor_user_id bigint      not null references users(id) on delete cascade,
  action        text        not null,   -- e.g. user.update_role, department.delete
  target_type   text,                   -- user | department | ...
  target_id     text,
  meta          jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_admin_audit_actor on admin_audit (actor_user_id);

-- Backend enforces its own JWT auth (integer user_id), not Supabase Auth/RLS.
alter table departments disable row level security;
alter table admin_audit disable row level security;

-- ── Bootstrap the first company admin (edit the email, then run) ───────────────
-- update users set role = 'org_admin' where email = 'you@company.com';

-- Optional: assign existing users to a default department so nothing is NULL:
-- update users set department_id = (select id from departments where key = 'operations')
--   where department_id is null;
