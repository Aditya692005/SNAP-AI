-- Conversation document scope: once a chat's first answer is grounded on a
-- specific set of documents, follow-up turns stay scoped to those same docs
-- (like a normal conversation) instead of re-guessing per message. NULL means
-- the thread has no established scope yet (or predates this migration).
--
-- Run in the Supabase SQL editor. Code falls back gracefully until then.

alter table ai_conversations
  add column if not exists document_ids uuid[] default null;
