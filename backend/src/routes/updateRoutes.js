// src/routes/updateRoutes.js
//
// The in-app "Updates" feed. Mount in server.js:
//   app.use("/api/updates", updateRoutes);
//
//   GET  /api/updates                 -> { updates: [...], unread: N }
//   POST /api/updates/mark-read        -> { ids? } mark some (or all) read
//   POST /api/updates/ai-response      -> { preview, conversation_id? } self-notify
//
// Most updates are created server-side by the events that produce them (a
// document share/retraction, a metric added to a shared board). The AI-response
// update is the exception: only the browser knows whether the user was actually
// looking at the chat when the answer landed, so it posts that one itself.

const express = require("express");

const requireAuth = require("../middleware/requireAuth");
const {
  listUpdates,
  countUnread,
  markRead,
  markAllRead,
  deleteUpdate,
  deleteAllForUser,
  createUpdatesForUsers,
} = require("../models/updateModel");

// Supabase/PostgREST codes for "the table isn't there yet" (migration not run).
const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

const router = express.Router();
router.use(requireAuth);

// GET /api/updates — the user's feed plus the live unread count.
router.get("/", async (req, res, next) => {
  try {
    const [updates, unread] = await Promise.all([
      listUpdates(req.user.id, { limit: 50 }),
      countUnread(req.user.id),
    ]);
    return res.json({ updates, unread });
  } catch (err) {
    // Before the migration runs the table doesn't exist — degrade to an empty
    // feed instead of erroring the whole shell.
    if (err?.code === "42P01" || err?.code === "PGRST205") {
      return res.json({ updates: [], unread: 0 });
    }
    return next(err);
  }
});

// POST /api/updates/mark-read — mark the given ids read, or all when ids is omitted.
router.post("/mark-read", async (req, res, next) => {
  try {
    const { ids } = req.body || {};
    if (Array.isArray(ids)) await markRead(req.user.id, ids);
    else await markAllRead(req.user.id);
    return res.json({ unread: await countUnread(req.user.id) });
  } catch (err) {
    if (err?.code === "42P01" || err?.code === "PGRST205") return res.json({ unread: 0 });
    return next(err);
  }
});

// DELETE /api/updates/all — clear the whole feed. Declared BEFORE /:id so "all"
// isn't captured as an id.
router.delete("/all", async (req, res, next) => {
  try {
    await deleteAllForUser(req.user.id);
    return res.json({ cleared: true, unread: 0 });
  } catch (err) {
    if (MISSING_TABLE.has(err?.code)) return res.json({ cleared: true, unread: 0 });
    return next(err);
  }
});

// DELETE /api/updates/:id — remove one update from the feed.
router.delete("/:id", async (req, res, next) => {
  try {
    await deleteUpdate(req.user.id, req.params.id);
    return res.json({ deleted: true, unread: await countUnread(req.user.id) });
  } catch (err) {
    if (MISSING_TABLE.has(err?.code)) return res.json({ deleted: true, unread: 0 });
    return next(err);
  }
});

// POST /api/updates/ai-response — the client reports that an AI answer arrived
// while the user wasn't watching the chat. Self-addressed: a user can only
// create this one type, only for themselves.
router.post("/ai-response", async (req, res, next) => {
  try {
    const preview = String(req.body?.preview || "").slice(0, 240);
    const conversationId = req.body?.conversation_id || null;
    await createUpdatesForUsers([req.user.id], {
      organizationId: req.user.organization_id,
      type: "ai_response",
      title: "AI Assistant replied",
      body: preview || "Your question has an answer waiting.",
      metadata: conversationId ? { conversation_id: conversationId } : null,
    });
    return res.status(201).json({ ok: true });
  } catch (err) {
    if (err?.code === "42P01" || err?.code === "PGRST205") return res.json({ ok: false });
    return next(err);
  }
});

module.exports = router;
