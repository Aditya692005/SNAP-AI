-- ============================================================================
-- SNAP-AI - Tiered document sharing
-- Run AFTER schema.sql + seed-roles.sql. Idempotent: safe to re-run.
--
-- Adds:
--   * permissions SHARE_DEPARTMENT_DOCUMENTS / SHARE_ORGANIZATION_DOCUMENTS
--       - manager   -> SHARE_DEPARTMENT_DOCUMENTS (own dept + sub-departments)
--       - org_admin -> both (any department, whole organization)
--     User-level sharing keeps using the existing ASSIGN_DOCUMENTS permission.
--   * document_access.access_type 'ORGANIZATION' - a read-only grant to every
--     member of the document's organization (all target columns NULL).
--
-- NOTE: JWTs embed the permission list at login, and requireAuth only
-- backfills permissions for tokens that lack them entirely. Existing
-- managers/org_admins must LOG IN AGAIN to pick up the new permissions.
-- ============================================================================

-- New permissions ---------------------------------------------------------------
insert into permissions (action, description) values
    ('SHARE_DEPARTMENT_DOCUMENTS',   'Share documents with a department (and its sub-departments)'),
    ('SHARE_ORGANIZATION_DOCUMENTS', 'Share documents with the entire organization (read only)')
on conflict (action) do nothing;

-- manager -> department-level sharing -------------------------------------------
insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.action in ('SHARE_DEPARTMENT_DOCUMENTS')
where r.name = 'manager' and r.organization_id is null
on conflict do nothing;

-- org_admin -> department + organization sharing --------------------------------
insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.action in ('SHARE_DEPARTMENT_DOCUMENTS', 'SHARE_ORGANIZATION_DOCUMENTS')
where r.name = 'org_admin' and r.organization_id is null
on conflict do nothing;

-- document_access: allow the ORGANIZATION tier -----------------------------------
alter table document_access drop constraint if exists chk_access_type;
alter table document_access add constraint chk_access_type
    check (access_type in ('ROLE', 'DEPARTMENT', 'USER', 'ORGANIZATION'));

alter table document_access drop constraint if exists chk_access_target;
alter table document_access add constraint chk_access_target check (
    (access_type = 'ROLE'         and role_id       is not null and department_id is null     and user_id is null)
 or (access_type = 'DEPARTMENT'   and department_id is not null and role_id       is null     and user_id is null)
 or (access_type = 'USER'         and user_id       is not null and role_id       is null     and department_id is null)
 or (access_type = 'ORGANIZATION' and role_id       is null     and department_id is null     and user_id is null)
);
