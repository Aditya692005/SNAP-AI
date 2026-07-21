-- ============================================================================
-- Updates / notifications feed.
-- Run once in the Supabase SQL Editor. Backs the in-app "Updates" sidebar:
-- one row per notification delivered to one recipient user.
--
-- type is one of:
--   'document_shared'    a document was shared with the user
--   'document_retracted' a document shared with the user was revoked/removed
--   'metric_added'       a metric was added to a board the user can see
--   'ai_response'        an AI answer arrived while the user wasn't watching chat
--
-- document_id is set for document updates so the client can open/download it.
-- read_at NULL means unread (drives the sidebar's red unread badge).
-- ============================================================================

create table if not exists user_updates (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references users(id) on delete cascade,
    organization_id uuid not null references organizations(id) on delete cascade,
    type            text not null,
    title           text not null,
    body            text,
    document_id     uuid references documents(id) on delete set null,
    metadata        jsonb,
    read_at         timestamptz,
    created_at      timestamptz not null default now()
);

-- The feed is always "this user's rows, newest first".
create index if not exists idx_user_updates_user_created
    on user_updates (user_id, created_at desc);

-- The unread-count query filters on user_id where read_at is null.
create index if not exists idx_user_updates_user_unread
    on user_updates (user_id)
    where read_at is null;
