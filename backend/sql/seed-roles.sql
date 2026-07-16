-- ============================================================================
-- SNAP-AI - Seed global roles + their permissions
-- Run once, AFTER schema.sql (which inserts the `permissions` rows).
--
-- These are GLOBAL roles (organization_id IS NULL): every organization shares
-- the same three baseline roles. Signup assigns users a role_id by name:
--   * the first user of a new email domain -> org_admin (creates the org)
--   * every subsequent user of that domain -> employee
-- An org_admin can later promote users to manager / org_admin.
--
-- Idempotent: safe to re-run (guards on name + null organization_id).
-- ============================================================================

-- Baseline roles --------------------------------------------------------------
insert into roles (name, description, organization_id)
select 'org_admin', 'Organization administrator - full control of the organization', null
where not exists (select 1 from roles where name = 'org_admin' and organization_id is null);

insert into roles (name, description, organization_id)
select 'manager', 'Department manager - manages documents and department dashboards', null
where not exists (select 1 from roles where name = 'manager' and organization_id is null);

insert into roles (name, description, organization_id)
select 'employee', 'Standard employee - uploads/views documents and uses the AI assistant', null
where not exists (select 1 from roles where name = 'employee' and organization_id is null);

-- org_admin -> ALL permissions ------------------------------------------------
insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
cross join permissions p
where r.name = 'org_admin' and r.organization_id is null
on conflict do nothing;

-- manager -> document ops + AI + view org/dept dashboards + manage dept dashboard
insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.action in (
    'ASSIGN_DOCUMENTS',
    'UPLOAD_DOCUMENTS',
    'VIEW_DOCUMENTS',
    'USE_AI_ASSISTANT',
    'VIEW_ORGANIZATION_DASHBOARD',
    'VIEW_DEPARTMENT_DASHBOARD',
    'MANAGE_DEPARTMENT_DASHBOARD'
)
where r.name = 'manager' and r.organization_id is null
on conflict do nothing;

-- employee -> upload/view/share docs + AI + view dept dashboard ----------------
-- ASSIGN_DOCUMENTS = user-to-user sharing of their own uploads (the share route
-- separately restricts non-admins to documents they uploaded).
insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.action in (
    'UPLOAD_DOCUMENTS',
    'VIEW_DOCUMENTS',
    'ASSIGN_DOCUMENTS',
    'USE_AI_ASSISTANT',
    'VIEW_DEPARTMENT_DASHBOARD'
)
where r.name = 'employee' and r.organization_id is null
on conflict do nothing;
