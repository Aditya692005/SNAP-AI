// backend/src/routes/ragRoutes.js
//
// Proxies /api/rag/* → Python RAG service at http://localhost:8000
// Mount in server.js:  app.use("/api/rag", ragRoutes);

const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const FormData = require("form-data");
const fetch = require("node-fetch");

const requireAuth = require("../middleware/requireAuth");
const {
  markWidgetsStaleForSource,
  markDepartmentWidgetsStaleForSource,
} = require("../services/widgetRefreshService");
const { extractAndStore } = require("../services/metricsService");
const { upsertStatus, getStatus, clearAllForUser } = require("../models/metricsModel");
const {
  createDocument,
  setDocumentStatus,
  resetDocumentForReupload,
  accessibleDocumentIds,
  findByFileName,
  findByContentHash,
  deleteAllForUser,
} = require("../models/documentModel");
const {
  createConversation,
  findConversation,
  listMessages,
  addMessage,
  recordRetrievedChunks,
} = require("../models/conversationModel");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const RAG_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";

// ── POST /api/rag/chat ────────────────────────────────────────────────────────
// Phase 3: persisted chat. Each turn lives in ai_conversations / ai_messages
// (with query_retrieved_chunks provenance), and the thread's history is loaded
// from the DB and sent to the RAG service — memory survives restarts.
//
// Body: { message, conversation_id?, document_ids?, source? }
//   conversation_id — continue an existing thread; omitted => a new one is created
//   document_ids    — the docs the user chose for this answer (subset of accessible)
//   source          — legacy single-file focus by file name
const MAX_HISTORY_MESSAGES = 20;

router.post("/chat", requireAuth, async (req, res, next) => {
  try {
    const { message, source, conversation_id, document_ids: selectedIds } = req.body;
    if (!message) return res.status(400).json({ message: "message is required" });
    const orgId = req.user.organization_id;

    // Scope retrieval to the documents this user is allowed to see. Passing an
    // explicit (possibly empty) list means a user only ever searches their docs.
    // When the user selected specific documents, honor the selection — but only
    // the intersection with what they can access (no privilege escalation).
    // Dept-sharers (managers/admins) also see docs shared to sub-departments of
    // the department they govern — same rule as GET /api/documents.
    const accessible = await accessibleDocumentIds(req.user.id, orgId, {
      subtreeDepartments: (req.user.permissions || []).includes("SHARE_DEPARTMENT_DOCUMENTS"),
    });
    let documentIds = accessible;
    let selected = false;
    if (Array.isArray(selectedIds) && selectedIds.length > 0) {
      const allowed = new Set(accessible);
      documentIds = selectedIds.filter((id) => allowed.has(id));
      if (documentIds.length === 0) {
        return res.status(403).json({ message: "You don't have access to the selected documents." });
      }
      selected = true;
    }

    let focusDocumentId = null;
    if (source) {
      const doc = await findByFileName(orgId, source);
      if (doc) focusDocumentId = doc.id;
    } else if (selected && documentIds.length === 1) {
      // Selecting exactly one document behaves like focusing on it.
      focusDocumentId = documentIds[0];
    }

    // Find-or-create the thread (ownership enforced), then load its history.
    let convo = null;
    if (conversation_id) {
      convo = await findConversation(conversation_id, req.user.id, orgId);
      if (!convo) return res.status(404).json({ message: "Conversation not found." });
    } else {
      convo = await createConversation(orgId, req.user.id, message.slice(0, 80));
    }
    const history = (await listMessages(convo.id))
      .filter((m) => m.sender_type === "USER" || m.sender_type === "AI")
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({
        role: m.sender_type === "USER" ? "user" : "assistant",
        content: m.content,
      }));

    // Persist the user's question BEFORE the (slow) LLM call. If the client
    // navigates away before the answer returns, the request still completes
    // here, so the question is never lost from the thread — reopening the
    // conversation shows it, and the answer once it's saved below. History was
    // built above from prior messages, so this new one isn't double-counted.
    await addMessage(convo.id, "USER", message).catch(() => {});

    const response = await fetch(`${RAG_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        session_id: `user_${req.user.id}`,
        history,
        organization_id: orgId,
        document_ids: documentIds,
        focus_document_id: focusDocumentId,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ message: err.detail || "RAG service error" });
    }

    const data = await response.json();

    // Persist the AI answer (the question was already saved above). Best-effort:
    // a storage hiccup must not eat the answer.
    let aiMessageId = null;
    try {
      const metadata = {};
      if (data.sources?.length) metadata.sources = data.sources;
      if (data.chart) metadata.chart = data.chart;
      if (data.document) metadata.document = data.document;
      const aiMsg = await addMessage(
        convo.id,
        "AI",
        data.answer,
        Object.keys(metadata).length ? metadata : null
      );
      aiMessageId = aiMsg.id;
      if (data.retrieved?.length) {
        await recordRetrievedChunks(aiMsg.id, data.retrieved).catch(() => {});
      }
    } catch {
      /* answer still goes back to the user */
    }

    return res.json({
      ...data,
      conversation_id: convo.id,
      conversation_title: convo.title,
      message_id: aiMessageId, // lets the client pin this chart as a widget
    });
  } catch (err) {
    return next(err);
  }
});

// ── POST /api/rag/chat/preview ────────────────────────────────────────────────
// Which documents WOULD be used to answer `message`? Runs the same scoped
// vector search as /chat but stops before the LLM, so the client can show the
// matched documents and let the user trim the set before asking for the answer.
// Body: { message, document_ids? } → { documents: [{ id, file_name, similarity }] }
router.post("/chat/preview", requireAuth, async (req, res, next) => {
  try {
    const { message, document_ids: selectedIds } = req.body;
    if (!message) return res.status(400).json({ message: "message is required" });
    const orgId = req.user.organization_id;

    // Same accessibility scoping as /chat — never previews docs the user can't see.
    const accessible = await accessibleDocumentIds(req.user.id, orgId, {
      subtreeDepartments: (req.user.permissions || []).includes("SHARE_DEPARTMENT_DOCUMENTS"),
    });
    let documentIds = accessible;
    if (Array.isArray(selectedIds) && selectedIds.length > 0) {
      const allowed = new Set(accessible);
      documentIds = selectedIds.filter((id) => allowed.has(id));
    }
    if (documentIds.length === 0) return res.json({ documents: [] });

    const response = await fetch(`${RAG_URL}/retrieve-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, organization_id: orgId, document_ids: documentIds }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ message: err.detail || "RAG service error" });
    }
    return res.json(await response.json());
  } catch (err) {
    return next(err);
  }
});

// ── POST /api/rag/visualize ───────────────────────────────────────────────────
// Asks the RAG service to turn an uploaded document's data into a chart/table
// specification (JSON) that the frontend renders and lets the user download.
router.post("/visualize", requireAuth, async (req, res, next) => {
  try {
    const { instruction, source } = req.body;
    if (!instruction) return res.status(400).json({ message: "instruction is required" });

    const response = await fetch(`${RAG_URL}/visualize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction, source: source || null }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ message: err.detail || "Visualization failed" });
    }

    return res.json(await response.json());
  } catch (err) {
    return next(err);
  }
});

// ── POST /api/rag/upload ──────────────────────────────────────────────────────
router.post("/upload", requireAuth, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: "file is required" });
    const orgId = req.user.organization_id;
    const filename = req.file.originalname;
    const overwrite = req.body?.overwrite === "true";

    // 0) Content-hash dedup: identical file BYTES already in this org under a
    //    DIFFERENT name → refuse, so the same data can't be double-counted. A
    //    same-name re-upload of identical content falls through to the filename
    //    update flow below (and a same-name UPDATE with new content has a new
    //    hash, so it isn't blocked here).
    const contentHash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    const dupByHash = await findByContentHash(orgId, contentHash);
    if (dupByHash && dupByHash.file_name !== filename) {
      return res.status(409).json({
        code: "DUPLICATE_CONTENT",
        duplicate: true,
        document_id: dupByHash.id,
        filename: dupByHash.file_name,
        message: `Identical content was already uploaded as "${dupByHash.file_name}" — skipped to avoid duplicate data.`,
      });
    }

    // 1) Register the document (org + uploader). A same-named document may
    //    already exist — the on-disk file, vectors, and dashboard metrics all
    //    key on the filename, so uploading it again is an UPDATE of that
    //    document, never a silent duplicate. Unless the client already
    //    confirmed the update (overwrite=true), reply 409 so it can ask the
    //    user to update the existing document or rename the new file.
    //    Updating follows the delete rule: only the uploader or an org_admin.
    const existing = await findByFileName(orgId, filename);
    let doc = existing;
    if (existing) {
      const canOverwrite =
        existing.uploaded_by_user_id === req.user.id || req.user.role === "org_admin";
      if (!canOverwrite || !overwrite) {
        return res.status(409).json({
          code: "DUPLICATE_FILENAME",
          can_overwrite: canOverwrite,
          message: canOverwrite
            ? `A document named "${filename}" already exists.`
            : `"${filename}" was already uploaded by someone else in your organization — rename your file to upload it.`,
        });
      }
      // Reuse the row: the RAG service clears this document_id's old
      // chunks/tables before re-indexing, so the content is replaced in place.
      await resetDocumentForReupload(existing.id, {
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        contentHash,
      });
    } else {
      doc = await createDocument(orgId, req.user.id, {
        fileName: filename,
        storagePath: `uploads/${filename}`,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        contentHash,
      });
    }

    // 2) Send the file to the RAG service to embed into Supabase (document_chunks
    //    + document_tables) under this document_id.
    const form = new FormData();
    form.append("file", req.file.buffer, { filename, contentType: req.file.mimetype });
    form.append("document_id", doc.id);
    form.append("organization_id", orgId);

    const response = await fetch(`${RAG_URL}/index`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      // Row stays PROCESSING; the file can be re-indexed later.
      return res.status(response.status).json({ message: err.detail || "Indexing failed" });
    }
    const data = await response.json();
    await setDocumentStatus(doc.id, "PROCESSED");
    // No document_access self-grant: the uploader can already see their own
    // documents via uploaded_by_user_id, and a grant row would (wrongly) show
    // them in the document's "Shared with" list.

    // 3) Record the document's dashboard status. Metric extraction is NOT run on
    //    upload — the dashboard shows only pinned AI charts, so there's no metrics
    //    view to feed and we don't want to spend an LLM call per upload. If a file
    //    of the same name was uploaded before, this is an UPDATE: flag any pinned
    //    charts built from it as stale so the user can refresh them (their Refresh
    //    button reruns /visualize against the now-updated on-disk file).
    const isReupload = !!(await getStatus(req.user.id, filename).catch(() => null));
    upsertStatus(req.user.id, filename, { status: "ready", included: true }).catch(() => {});
    if (isReupload) {
      markWidgetsStaleForSource(req.user.id, orgId, filename).catch(() => {});
    }

    // Extract dashboard metrics in the background (open-ended + the user's
    // tracked definitions), tagged with this document/org so they aggregate at
    // any scope. Phase 4 turns newly-discovered metrics into KPI widgets.
    extractAndStore(req.user.id, filename, { documentId: doc.id, organizationId: orgId }).catch(() => {});
    // Department boards are shared, so an UPDATE by ANY member (org-level
    // re-upload, detected above via findByFileName → `existing`) must flag their
    // charts stale — not just the re-uploader's own personal charts.
    if (existing) {
      markDepartmentWidgetsStaleForSource(orgId, filename).catch(() => {});
    }

    return res.json({ document_id: doc.id, filename, ...data });
  } catch (err) {
    return next(err);
  }
});

// ── POST /api/rag/ingest ──────────────────────────────────────────────────────
// Indexes a file already on disk (e.g. a generated report) so the AI can answer
// questions about it — used by the "Add to AI" action on generated documents.
router.post("/ingest", requireAuth, async (req, res, next) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ message: "filename is required" });
    const orgId = req.user.organization_id;

    // Register the generated file as a document, then index it into Supabase.
    // "Add to AI" clicked twice for the same report reuses the existing row
    // (re-indexing replaces its chunks) instead of creating a duplicate.
    const existing = await findByFileName(orgId, filename);
    let doc = existing;
    if (existing) {
      if (existing.uploaded_by_user_id !== req.user.id && req.user.role !== "org_admin") {
        return res.status(409).json({
          message: `"${filename}" already belongs to another user in your organization.`,
        });
      }
      await resetDocumentForReupload(existing.id, { mimeType: "application/pdf" });
    } else {
      doc = await createDocument(orgId, req.user.id, {
        fileName: filename,
        storagePath: `uploads/${filename}`,
        mimeType: "application/pdf",
      });
    }

    const response = await fetch(`${RAG_URL}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, document_id: doc.id, organization_id: orgId }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ message: err.detail || "Ingest failed" });
    }
    const data = await response.json();
    await setDocumentStatus(doc.id, "PROCESSED");

    return res.json({ document_id: doc.id, ...data });
  } catch (err) {
    return next(err);
  }
});

// ── DELETE /api/rag/documents ─────────────────────────────────────────────────
// Clears the RAG vector store + files on disk, AND wipes this user's stored
// dashboard metrics so the dashboard resets to "no data yet".
router.delete("/documents", requireAuth, async (req, res, next) => {
  try {
    const response = await fetch(`${RAG_URL}/documents`, { method: "DELETE" });
    const data = await response.json();
    await clearAllForUser(req.user.id);
    // Also remove this user's Supabase documents (cascades chunks/tables/access).
    await deleteAllForUser(req.user.id, req.user.organization_id).catch(() => {});
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

// ── GET /api/rag/download/:filename ───────────────────────────────────────────
// Streams the original uploaded source document back to the client.
router.get("/download/:filename", requireAuth, async (req, res, next) => {
  try {
    const filename = req.params.filename;
    const response = await fetch(
      `${RAG_URL}/download/${encodeURIComponent(filename)}`
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res
        .status(response.status)
        .json({ message: err.detail || "Download failed" });
    }

    // Forward the download headers so the browser saves it with the right name.
    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") || "application/octet-stream"
    );
    res.setHeader(
      "Content-Disposition",
      response.headers.get("content-disposition") ||
        `attachment; filename="${filename}"`
    );

    // node-fetch v2 returns a Node stream; pipe it straight to the response.
    return response.body.pipe(res);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
