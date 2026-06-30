// src/models/auditModel.js
// Records privileged admin actions for accountability.

const supabase = require("../../supabase/supabase");

async function logAdminAction(actorUserId, action, { targetType, targetId, meta } = {}) {
  const { error } = await supabase.from("admin_audit").insert({
    actor_user_id: actorUserId,
    action,
    target_type: targetType ?? null,
    target_id: targetId != null ? String(targetId) : null,
    meta: meta ?? null,
  });
  if (error) throw error;
}

module.exports = { logAdminAction };
