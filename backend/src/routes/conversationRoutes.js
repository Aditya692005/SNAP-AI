// src/routes/conversationRoutes.js
//
// Phase 3: view/manage persisted AI chat threads. Mount in server.js:
//   app.use("/api/conversations", conversationRoutes);
//
//   GET    /api/conversations      -> this user's threads, newest first
//   GET    /api/conversations/:id  -> one thread + its messages
//   DELETE /api/conversations/:id  -> delete a thread (messages cascade)
//
// Messages are WRITTEN by POST /api/rag/chat, not here.

const express = require("express");

const requireAuth = require("../middleware/requireAuth");
const requirePermission = require("../middleware/requirePermission");
const AppError = require("../utils/AppError");
const {
  listConversations,
  findConversation,
  deleteConversation,
  listMessages,
} = require("../models/conversationModel");

const router = express.Router();
router.use(requireAuth);
// Chat threads are part of the AI-assistant surface — same gate as /api/rag/chat.
router.use(requirePermission("USE_AI_ASSISTANT"));

router.get("/", async (req, res, next) => {
  try {
    const conversations = await listConversations(req.user.id, req.user.organization_id);
    return res.json({ conversations });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const convo = await findConversation(req.params.id, req.user.id, req.user.organization_id);
    if (!convo) throw new AppError("Conversation not found.", 404);
    const messages = await listMessages(convo.id);
    return res.json({ conversation: convo, messages });
  } catch (err) {
    return next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const convo = await findConversation(req.params.id, req.user.id, req.user.organization_id);
    if (!convo) throw new AppError("Conversation not found.", 404);
    await deleteConversation(convo.id, req.user.id, req.user.organization_id);
    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
