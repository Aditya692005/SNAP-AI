-- ============================================================================
-- 1. Organizations
-- ============================================================================
create table if not exists organizations (
    id                uuid primary key default gen_random_uuid(),
    name              varchar(255) not null,
    description       text,
    industry          varchar(100),
    contact_email     varchar(255) not null,
    country           varchar(100) not null,
    subscription_plan varchar(50)  not null default 'FREE'
        check (subscription_plan in ('FREE', 'STARTER', 'PRO', 'ENTERPRISE')),
    status            varchar(20)  not null default 'ACTIVE'
        check (status in ('ACTIVE', 'SUSPENDED', 'INACTIVE')),
    created_at        timestamptz  not null default now(),
    updated_at        timestamptz  not null default now()
);

-- ============================================================================
-- 2. Departments
-- ============================================================================
create table if not exists departments (
    id              uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    name            varchar(255) not null,
    description     text,
    parent_id       uuid,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint fk_department_organization
        foreign key (organization_id) references organizations(id) on delete cascade,
    constraint fk_department_parent
        foreign key (parent_id) references departments(id) on delete set null
);

-- ============================================================================
-- 3. Roles
-- ============================================================================
create table if not exists roles (
    id              uuid primary key default gen_random_uuid(),
    organization_id uuid,
    name            varchar(100) not null,
    description     text,
    created_by      uuid,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint fk_role_organization
        foreign key (organization_id) references organizations(id) on delete cascade
);

-- ============================================================================
-- 4. Permissions
-- ============================================================================
create table if not exists permissions (
    id          uuid primary key default gen_random_uuid(),
    action      varchar(100) not null unique,
    description text,
    created_at  timestamptz not null default now()
);

insert into permissions (action, description) values
    ('MANAGE_ORGANIZATION',          'Edit organization details'),
    ('MANAGE_USERS',                 'Create, edit, deactivate and manage users'),
    ('MANAGE_DEPARTMENTS',           'Create, edit and manage departments'),
    ('MANAGE_ROLES',                 'Create and manage custom roles'),
    ('ASSIGN_DOCUMENTS',             'Assign document upload tasks to users'),
    ('UPLOAD_DOCUMENTS',             'Upload assigned documents'),
    ('VIEW_DOCUMENTS',               'View accessible documents'),
    ('USE_AI_ASSISTANT',             'Access the AI Assistant'),
    ('VIEW_ORGANIZATION_DASHBOARD',  'View organization wide dashboard'),
    ('MANAGE_ORGANIZATION_DASHBOARD','Create and edit organization wide dashboard'),
    ('VIEW_DEPARTMENT_DASHBOARD',    'View department wide dashboard'),
    ('MANAGE_DEPARTMENT_DASHBOARD',  'Create and edit department wide dashboard')
on conflict (action) do nothing;

-- ============================================================================
-- 5. Role ↔ Permission join
-- ============================================================================
create table if not exists role_permissions (
    role_id       uuid not null,
    permission_id uuid not null,
    primary key (role_id, permission_id),
    foreign key (role_id)       references roles(id)       on delete cascade,
    foreign key (permission_id) references permissions(id) on delete cascade
);

-- ============================================================================
-- 6. Users
-- ============================================================================
create table if not exists users (
    id                         uuid primary key default gen_random_uuid(),
    organization_id            uuid not null,
    department_id              uuid,
    role_id                    uuid not null,
    name                       varchar(255) not null,
    email                      varchar(255) not null unique,
    password_hash              text not null,
    email_verified             boolean default false,
    status                     varchar(20) default 'ACTIVE',
    last_login                 timestamptz,
    created_at                 timestamptz not null default now(),
    updated_at                 timestamptz not null default now(),
    email_verification_token   varchar(255),
    email_verification_expires timestamptz,
    failed_login_attempts      int default 0,
    locked_until               timestamptz,
    foreign key (organization_id) references organizations(id) on delete cascade,
    foreign key (department_id)   references departments(id)   on delete set null,
    foreign key (role_id)         references roles(id)
);

-- Deferred FK: roles.created_by → users.id (users didn't exist when roles was created)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_role_created_by'
          AND table_name = 'roles'
    ) THEN
        ALTER TABLE roles
            ADD CONSTRAINT fk_role_created_by
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;
