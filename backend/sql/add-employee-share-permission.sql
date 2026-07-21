-- ============================================================================
-- SNAP-AI - Let employees share documents by default
-- Run AFTER schema.sql + seed-roles.sql. Idempotent: safe to re-run.
--
-- Grants the global `employee` role ASSIGN_DOCUMENTS — the permission behind
-- user-to-user document sharing. Employees can then share documents THEY
-- uploaded with individual users (the share route already limits non-admins
-- to their own uploads, and department/organization-wide sharing still needs
-- SHARE_DEPARTMENT_DOCUMENTS / SHARE_ORGANIZATION_DOCUMENTS).
--
-- seed-roles.sql was updated to include this for FRESH installs; this file
-- backfills an existing database.
--
-- NOTE: JWTs embed the permission list at login, and requireAuth only
-- recomputes it on a role CHANGE. Existing employees must LOG IN AGAIN
-- (or be re-issued a token) to pick up the new permission.
-- ============================================================================

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.action = 'ASSIGN_DOCUMENTS'
where r.name = 'employee' and r.organization_id is null
on conflict do nothing;
