// src/models/conversationModel.js
//
// Phase 3: persisted AI chat history. One ai_conversations row per chat thread,
// ai_messages rows per turn (USER / AI), and query_retrieved_chunks provenance
// linking each AI answer to the document_chunks it was grounded on.

const supabase = require("../../supabase/supabase");

async function createConversation(organizationId, userId, title) {
  const { data, error } = await supabase
    .from("ai_conversations")
    .insert({
      organization_id: organizationId,
      user_id: userId,
      title: (title || "New conversation").slice(0, 255),
    })
    .select("id, title, created_at")
    .single();
  if (error) throw error;
  return data;
}

// Only the owner's conversations, newest first. The document_ids column comes
// from add-conversation-document-ids.sql — fall back without it (42703) so
// threads keep listing until the migration runs.
async function listConversations(userId, organizationId) {
  let { data, error } = await supabase
    .from("ai_conversations")
    .select("id, title, created_at, document_ids")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error && error.code === MISSING_COLUMN) {
    ({ data, error } = await supabase
      .from("ai_conversations")
      .select("id, title, created_at")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false }));
  }
  if (error) throw error;
  return data || [];
}

// Ownership check baked in: returns null unless this user owns the thread.
async function findConversation(id, userId, organizationId) {
  let { data, error } = await supabase
    .from("ai_conversations")
    .select("id, title, created_at, document_ids")
    .eq("id", id)
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error && error.code === MISSING_COLUMN) {
    ({ data, error } = await supabase
      .from("ai_conversations")
      .select("id, title, created_at")
      .eq("id", id)
      .eq("user_id", userId)
      .eq("organization_id", organizationId)
      .maybeSingle());
  }
  if (error) return null;
  return data;
}

// Anchor a thread to the documents its first scoped answer was grounded on.
// Writes only while document_ids is still NULL, so a user's later deliberate
// re-selection (which re-anchors via the frontend) isn't clobbered by every
// follow-up turn. Best-effort: missing column (migration not run) is ignored.
async function setConversationDocumentIds(conversationId, documentIds) {
  const { error } = await supabase
    .from("ai_conversations")
    .update({ document_ids: documentIds })
    .eq("id", conversationId)
    .is("document_ids", null);
  // 42703 = undefined column (reads); PGRST204 = column missing from the
  // PostgREST schema cache (writes). Either way: migration not run yet.
  if (error && error.code !== MISSING_COLUMN && error.code !== "PGRST204") throw error;
}

// Messages cascade via fk_conversation on delete.
async function deleteConversation(id, userId, organizationId) {
  const { error } = await supabase
    .from("ai_conversations")
    .delete()
    .eq("id", id)
    .eq("user_id", userId)
    .eq("organization_id", organizationId);
  if (error) throw error;
}

// The metadata column comes from add-ai-message-metadata.sql. Until that
// migration runs, fall back to plain messages (42703 = undefined column) so
// chat keeps working — replies just lose their saved charts/sources.
const MISSING_COLUMN = "42703";

async function listMessages(conversationId) {
  let { data, error } = await supabase
    .from("ai_messages")
    .select("id, sender_type, content, metadata, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error && error.code === MISSING_COLUMN) {
    ({ data, error } = await supabase
      .from("ai_messages")
      .select("id, sender_type, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true }));
  }
  if (error) throw error;
  return data || [];
}

// One message by id (with its conversation + metadata), or null. Used by the
// widget refresh to recover the chart spec's source and originating request.
async function findMessageById(id) {
  let { data, error } = await supabase
    .from("ai_messages")
    .select("id, conversation_id, sender_type, content, metadata, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error && error.code === MISSING_COLUMN) {
    ({ data, error } = await supabase
      .from("ai_messages")
      .select("id, conversation_id, sender_type, content, created_at")
      .eq("id", id)
      .maybeSingle());
  }
  if (error) throw error;
  return data || null;
}

// Remove a single message (best-effort cleanup). Used to roll back a USER
// question whose turn failed before an answer was produced, so it doesn't
// linger as an unanswered turn that the next request would feed back to the LLM.
async function deleteMessage(id) {
  const { error } = await supabase.from("ai_messages").delete().eq("id", id);
  if (error) throw error;
}

async function addMessage(conversationId, senderType, content, metadata = null) {
  const row = {
    conversation_id: conversationId,
    sender_type: senderType,
    content,
  };
  let { data, error } = await supabase
    .from("ai_messages")
    .insert(metadata ? { ...row, metadata } : row)
    .select("id")
    .single();
  if (error && error.code === MISSING_COLUMN && metadata) {
    ({ data, error } = await supabase.from("ai_messages").insert(row).select("id").single());
  }
  if (error) throw error;
  return data;
}

// AI-generated reports across all of this user's threads: every AI message
// whose metadata carries a generated document ({title, filename}). Powers the
// Reports page — the files themselves live in Storage under generated/ and are
// served by GET /api/rag/download/:filename.
async function listGeneratedReports(userId, organizationId) {
  const { data, error } = await supabase
    .from("ai_messages")
    .select(
      "id, metadata, created_at, ai_conversations!inner(id, title, user_id, organization_id)"
    )
    .eq("ai_conversations.user_id", userId)
    .eq("ai_conversations.organization_id", organizationId)
    .not("metadata->document", "is", null)
    .order("created_at", { ascending: false });
  if (error) {
    if (error.code === MISSING_COLUMN) return []; // metadata migration not run
    throw error;
  }
  return (data || [])
    .filter((m) => m.metadata?.document?.filename)
    .map((m) => ({
      id: m.id,
      title: m.metadata.document.title || m.metadata.document.filename,
      filename: m.metadata.document.filename,
      conversation_id: m.ai_conversations.id,
      conversation_title: m.ai_conversations.title,
      created_at: m.created_at,
    }));
}

// Provenance: which chunks (and how similar) grounded an AI answer.
// retrieved = [{chunk_id, document_id, similarity}] from the RAG service.
async function recordRetrievedChunks(messageId, retrieved) {
  const rows = (retrieved || [])
    .filter((r) => r && r.chunk_id)
    .map((r) => ({
      message_id: messageId,
      chunk_id: r.chunk_id,
      relevance_score: r.similarity ?? null,
    }));
  if (rows.length === 0) return;
  const { error } = await supabase.from("query_retrieved_chunks").insert(rows);
  if (error) throw error;
}

module.exports = {
  createConversation,
  listConversations,
  findConversation,
  setConversationDocumentIds,
  deleteConversation,
  listMessages,
  findMessageById,
  listGeneratedReports,
  addMessage,
  deleteMessage,
  recordRetrievedChunks,
};
