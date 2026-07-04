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

// Only the owner's conversations, newest first.
async function listConversations(userId, organizationId) {
  const { data, error } = await supabase
    .from("ai_conversations")
    .select("id, title, created_at")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// Ownership check baked in: returns null unless this user owns the thread.
async function findConversation(id, userId, organizationId) {
  const { data, error } = await supabase
    .from("ai_conversations")
    .select("id, title, created_at")
    .eq("id", id)
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return null;
  return data;
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
  deleteConversation,
  listMessages,
  findMessageById,
  addMessage,
  recordRetrievedChunks,
};
