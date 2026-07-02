-- ============================================================================
-- SNAP-AI - Database Schema v2 (full multi-tenant, PostgreSQL / Supabase)
-- Runnable: paste into the Supabase SQL Editor (or psql) on a fresh database.
--
-- Run order:
--   1. schema.sql                  (this file - tables, indexes, triggers)
--   2. seed-roles.sql              (global roles + role_permissions)
--   3. add-app-extension-tables.sql(app-only tables v2 omits, uuid-keyed)
--   4. rpc-match-chunks.sql        (pgvector similarity-search function)
-- ============================================================================

-- Prerequisites ---------------------------------------------------------------
create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists vector;      -- VECTOR(384) for embeddings (all-MiniLM-L6-v2)

-- Auto-maintain updated_at -----------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ============================================================================
-- 1. Organizations
-- ============================================================================
create table organizations (
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
create table departments (
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
create table roles (
    id              uuid primary key default gen_random_uuid(),
    organization_id uuid,                       -- nullable: NULL = global/system role
    name            varchar(100) not null,
    description     text,
    created_by      uuid,                        -- FK added after `users` exists
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint fk_role_organization
        foreign key (organization_id) references organizations(id) on delete cascade
);

-- ============================================================================
-- 4. Permissions
-- ============================================================================
create table permissions (
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
    ('MANAGE_DEPARTMENT_DASHBOARD',  'Create and edit department wide dashboard');

-- ============================================================================
-- 5. Role - Permission join
-- ============================================================================
create table role_permissions (
    role_id       uuid not null,
    permission_id uuid not null,
    primary key (role_id, permission_id),
    foreign key (role_id)       references roles(id)       on delete cascade,
    foreign key (permission_id) references permissions(id) on delete cascade
);

-- ============================================================================
-- 6. Users
-- ============================================================================
create table users (
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
    password_reset_otp         varchar(255),   -- bcrypt hash of the reset OTP
    password_reset_expires     timestamptz,
    password_reset_attempts    int default 0,  -- wrong-OTP tries; locks the OTP at the cap
    foreign key (organization_id) references organizations(id) on delete cascade,
    foreign key (department_id)   references departments(id)   on delete set null,
    foreign key (role_id)         references roles(id)
);

-- Deferred FK: roles.created_by -> users.id (users didn't exist when roles was created)
alter table roles
    add constraint fk_role_created_by
    foreign key (created_by) references users(id) on delete set null;

-- ============================================================================
-- 7. Documents
-- ============================================================================
create table documents (
    id                   uuid primary key default gen_random_uuid(),
    organization_id      uuid not null,
    uploaded_by_user_id  uuid not null,
    title                varchar(255) not null,
    description          text,
    file_name            varchar(255) not null,
    storage_path         text not null,
    file_size            bigint,
    mime_type            varchar(100),
    status               varchar(20) not null default 'UPLOADED'
        check (status in ('UPLOADED', 'PROCESSING', 'PROCESSED')),
    parent_document_id   uuid,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),
    constraint fk_document_organization
        foreign key (organization_id) references organizations(id) on delete cascade,
    constraint fk_document_uploader
        foreign key (uploaded_by_user_id) references users(id) on delete restrict,
    constraint fk_document_parent
        foreign key (parent_document_id) references documents(id) on delete set null
);

-- ============================================================================
-- 8. Document access
-- ============================================================================
create table document_access (
    id                  uuid primary key default gen_random_uuid(),
    document_id         uuid not null,
    access_type         varchar(20) not null,
    role_id             uuid,
    department_id       uuid,
    user_id             uuid,
    granted_by_user_id  uuid not null,
    created_at          timestamptz not null default now(),
    expires_at          timestamptz,
    constraint fk_access_document
        foreign key (document_id) references documents(id) on delete cascade,
    constraint fk_access_role
        foreign key (role_id) references roles(id) on delete cascade,
    constraint fk_access_department
        foreign key (department_id) references departments(id) on delete cascade,
    constraint fk_access_user
        foreign key (user_id) references users(id) on delete cascade,
    constraint fk_access_granted_by
        foreign key (granted_by_user_id) references users(id) on delete restrict,
    constraint chk_access_type
        check (access_type in ('ROLE', 'DEPARTMENT', 'USER')),
    constraint chk_access_target check (
        (access_type = 'ROLE'       and role_id       is not null and department_id is null     and user_id is null)
     or (access_type = 'DEPARTMENT' and department_id is not null and role_id       is null     and user_id is null)
     or (access_type = 'USER'       and user_id       is not null and role_id       is null     and department_id is null)
    )
);

-- ============================================================================
-- 9. Activity logs
-- ============================================================================
create table activity_logs (
    id              uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    user_id         uuid not null,
    action          varchar(100) not null,
    entity_type     varchar(50) not null,
    entity_id       uuid,
    details         jsonb,
    created_at      timestamptz not null default now(),
    constraint fk_log_organization
        foreign key (organization_id) references organizations(id) on delete cascade,
    constraint fk_log_user
        foreign key (user_id) references users(id) on delete restrict
);

-- ============================================================================
-- 10. AI conversations
-- ============================================================================
create table ai_conversations (
    id              uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    user_id         uuid not null,
    title           varchar(255),
    created_at      timestamptz not null default now(),
    foreign key (organization_id) references organizations(id) on delete cascade,
    foreign key (user_id)         references users(id)         on delete cascade
);

-- ============================================================================
-- 11. AI messages
-- ============================================================================
create table ai_messages (
    id              uuid primary key default gen_random_uuid(),
    conversation_id uuid not null,
    sender_type     varchar(20) not null,
    content         text not null,
    metadata        jsonb,         -- AI-reply extras: {sources, chart, document}
    created_at      timestamptz not null default now(),
    constraint chk_sender_type
        check (sender_type in ('USER', 'AI', 'SYSTEM')),
    foreign key (conversation_id) references ai_conversations(id) on delete cascade
);

-- ============================================================================
-- 12. Document chunks (RAG)
-- ============================================================================
create table document_chunks (
    id          uuid primary key default gen_random_uuid(),
    document_id uuid not null,
    chunk_index int not null,
    chunk_text  text not null,
    embedding   vector(384),   -- matches the all-MiniLM-L6-v2 RAG model (384 dims)
    created_at  timestamptz not null default now(),
    foreign key (document_id) references documents(id) on delete cascade
);

-- ============================================================================
-- 13. Document tables
-- ============================================================================
create table document_tables (
    id              uuid primary key default gen_random_uuid(),
    document_id     uuid not null,
    sheet_name      varchar(255),
    table_name      varchar(255),
    table_data      jsonb not null,
    table_index     int not null default 0,
    heading_context text,
    created_at      timestamptz not null default now(),
    foreign key (document_id) references documents(id) on delete cascade
);

-- ============================================================================
-- 14. Query - retrieved chunks (RAG provenance)
-- ============================================================================
create table query_retrieved_chunks (
    id              uuid primary key default gen_random_uuid(),
    message_id      uuid not null,
    chunk_id        uuid not null,
    relevance_score float,
    created_at      timestamptz not null default now(),
    foreign key (message_id) references ai_messages(id)      on delete cascade,
    foreign key (chunk_id)   references document_chunks(id)  on delete cascade
);

-- ============================================================================
-- 15. Personal dashboards
-- ============================================================================
create table personal_dashboards (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null,
    organization_id uuid not null,
    name            varchar(255) not null,
    is_default      boolean default false,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    foreign key (user_id)         references users(id)         on delete cascade,
    foreign key (organization_id) references organizations(id) on delete cascade
);

-- ============================================================================
-- 16. Department dashboards
-- ============================================================================
create table department_dashboards (
    id                  uuid primary key default gen_random_uuid(),
    department_id       uuid not null,
    organization_id     uuid not null,
    name                varchar(255) not null,
    created_by_user_id  uuid not null,
    is_default          boolean default false,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    updated_by_user_id  uuid,
    foreign key (department_id)      references departments(id)   on delete cascade,
    foreign key (organization_id)    references organizations(id) on delete cascade,
    foreign key (created_by_user_id) references users(id)         on delete restrict,
    foreign key (updated_by_user_id) references users(id)         on delete set null
);

-- ============================================================================
-- 17. Organization dashboards
-- ============================================================================
create table organization_dashboards (
    id                  uuid primary key default gen_random_uuid(),
    organization_id     uuid not null,
    name                varchar(255) not null,
    created_by_user_id  uuid not null,
    is_default          boolean default false,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    updated_by_user_id  uuid,
    foreign key (organization_id)    references organizations(id) on delete cascade,
    foreign key (created_by_user_id) references users(id)         on delete restrict,
    foreign key (updated_by_user_id) references users(id)         on delete set null
);

-- ============================================================================
-- 18. Dashboard widgets
-- ============================================================================
create table dashboard_widgets (
    id                        uuid primary key default gen_random_uuid(),
    -- exactly one of these three is set, the others NULL
    personal_dashboard_id     uuid,
    department_dashboard_id   uuid,
    organization_dashboard_id uuid,
    widget_type               varchar(100) not null,
    title                     varchar(255),
    config                    jsonb,
    position_x                int not null default 0,
    position_y                int not null default 0,
    width                     int not null default 1,
    height                    int not null default 1,
    ai_message_id             uuid,
    created_at                timestamptz not null default now(),
    updated_at                timestamptz not null default now(),
    foreign key (personal_dashboard_id)
        references personal_dashboards(id)     on delete cascade,
    foreign key (department_dashboard_id)
        references department_dashboards(id)   on delete cascade,
    foreign key (organization_dashboard_id)
        references organization_dashboards(id) on delete cascade,
    foreign key (ai_message_id)
        references ai_messages(id)             on delete set null,
    constraint chk_widget_owner check (
        (personal_dashboard_id     is not null and department_dashboard_id is null and organization_dashboard_id is null)
     or (department_dashboard_id   is not null and personal_dashboard_id   is null and organization_dashboard_id is null)
     or (organization_dashboard_id is not null and personal_dashboard_id   is null and department_dashboard_id   is null)
    )
);

-- ============================================================================
-- 19. Reports
-- ============================================================================
create table reports (
    id                  uuid primary key default gen_random_uuid(),
    organization_id     uuid not null,
    department_id       uuid,
    created_by_user_id  uuid not null,
    title               varchar(255) not null,
    description         text,
    report_type         varchar(20) default 'MANUAL',
    visibility          varchar(20) default 'PERSONAL',
    config              jsonb,
    schedule            varchar(100),
    last_run_at         timestamptz,
    status              varchar(20) default 'ACTIVE',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint chk_report_type
        check (report_type in ('MANUAL', 'SCHEDULED')),
    constraint chk_report_visibility
        check (visibility in ('PERSONAL', 'DEPARTMENT', 'ORGANIZATION')),
    constraint chk_report_status
        check (status in ('ACTIVE', 'INACTIVE')),
    constraint chk_schedule check (
        (report_type = 'SCHEDULED' and schedule is not null)
     or (report_type = 'MANUAL'    and schedule is null)
    ),
    constraint chk_report_visibility_target check (
        (visibility = 'PERSONAL'     and department_id is null)
     or (visibility = 'DEPARTMENT'   and department_id is not null)
     or (visibility = 'ORGANIZATION' and department_id is null)
    ),
    foreign key (organization_id)    references organizations(id) on delete cascade,
    foreign key (department_id)      references departments(id)   on delete set null,
    foreign key (created_by_user_id) references users(id)         on delete restrict
);

-- ============================================================================
-- 20. Report results
-- ============================================================================
create table report_results (
    id                   uuid primary key default gen_random_uuid(),
    report_id            uuid not null,
    generated_by_user_id uuid not null,
    result_data          jsonb,
    status               varchar(20) default 'PENDING',
    error_message        text,
    generated_at         timestamptz not null default now(),
    constraint chk_result_status
        check (status in ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
    foreign key (report_id)            references reports(id) on delete cascade,
    foreign key (generated_by_user_id) references users(id)   on delete restrict
);

-- ============================================================================
-- Indexes (FK / lookup columns that get filtered often)
-- ============================================================================
create index idx_departments_org           on departments (organization_id);
create index idx_departments_parent         on departments (parent_id);
create index idx_roles_org                  on roles (organization_id);
create index idx_users_org                  on users (organization_id);
create index idx_users_department           on users (department_id);
create index idx_users_role                 on users (role_id);
create index idx_users_verification_token   on users (email_verification_token);
create index idx_documents_org              on documents (organization_id);
create index idx_documents_uploader         on documents (uploaded_by_user_id);
create index idx_document_access_document   on document_access (document_id);
create index idx_activity_logs_org          on activity_logs (organization_id);
create index idx_activity_logs_user         on activity_logs (user_id);
create index idx_ai_conversations_user      on ai_conversations (user_id);
create index idx_ai_messages_conversation   on ai_messages (conversation_id);
create index idx_document_chunks_document   on document_chunks (document_id);
create index idx_document_tables_document   on document_tables (document_id);
create index idx_qrc_message                on query_retrieved_chunks (message_id);
create index idx_widgets_personal_dash      on dashboard_widgets (personal_dashboard_id);
create index idx_widgets_department_dash    on dashboard_widgets (department_dashboard_id);
create index idx_widgets_org_dash           on dashboard_widgets (organization_dashboard_id);
create index idx_reports_org                on reports (organization_id);
create index idx_report_results_report      on report_results (report_id);

-- Approximate-nearest-neighbour index for embeddings (cosine).
-- Tune `lists` to roughly sqrt(row count) once you have data, and REINDEX after
-- the table has been populated (ivfflat clusters are meaningless on an empty table).
create index idx_document_chunks_embedding
    on document_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ============================================================================
-- updated_at triggers
-- ============================================================================
create trigger trg_organizations_updated      before update on organizations          for each row execute function set_updated_at();
create trigger trg_departments_updated         before update on departments            for each row execute function set_updated_at();
create trigger trg_roles_updated               before update on roles                  for each row execute function set_updated_at();
create trigger trg_users_updated               before update on users                  for each row execute function set_updated_at();
create trigger trg_documents_updated           before update on documents              for each row execute function set_updated_at();
create trigger trg_personal_dashboards_updated before update on personal_dashboards    for each row execute function set_updated_at();
create trigger trg_department_dash_updated     before update on department_dashboards  for each row execute function set_updated_at();
create trigger trg_org_dash_updated            before update on organization_dashboards for each row execute function set_updated_at();
create trigger trg_widgets_updated             before update on dashboard_widgets      for each row execute function set_updated_at();
create trigger trg_reports_updated             before update on reports                for each row execute function set_updated_at();
