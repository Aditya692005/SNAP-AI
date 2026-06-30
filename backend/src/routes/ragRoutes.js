// backend/src/routes/ragRoutes.js
//
// Proxies /api/rag/* → Python RAG service at http://localhost:8000
// Mount in server.js:  app.use("/api/rag", ragRoutes);

const express = require("express");
const multer = require("multer");
const FormData = require("form-data");
const fetch = require("node-fetch");

const requireAuth = require("../middleware/requireAuth");
const { extractAndStore } = require("../services/metricsService");
const { upsertStatus, clearAllForUser } = require("../models/metricsModel");
const {
  createDocument,
  setDocumentStatus,
  grantAccess,
  accessibleDocumentIds,
  findByFileName,
  deleteAllForUser,
} = require("../models/documentModel");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const RAG_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";

// ── POST /api/rag/chat ────────────────────────────────────────────────────────
// Stateless proxy to the RAG service. Conversational memory is kept in-memory by
// the RAG service per session_id (here, the authenticated user) — nothing is
// persisted to the database.
router.post("/chat", requireAuth, async (req, res, next) => {
  try {
    const { message, source } = req.body;
    if (!message) return res.status(400).json({ message: "message is required" });
    const orgId = req.user.organization_id;

    // Scope retrieval to the documents this user is allowed to see. Passing an
    // explicit (possibly empty) list means a user only ever searches their docs.
    const documentIds = await accessibleDocumentIds(req.user.id, orgId);
    let focusDocumentId = null;
    if (source) {
      const doc = await findByFileName(orgId, source);
      if (doc) focusDocumentId = doc.id;
    }

    const response = await fetch(`${RAG_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        session_id: `user_${req.user.id}`,
        organization_id: orgId,
        document_ids: documentIds,
        focus_document_id: focusDocumentId,
      }),
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

    // 1) Register the document (org + uploader).
    const doc = await createDocument(orgId, req.user.id, {
      fileName: filename,
      storagePath: `uploads/${filename}`,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
    });

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

    // 3) Grant the uploader access to their own document.
    await grantAccess({
      documentId: doc.id,
      accessType: "USER",
      userId: req.user.id,
      grantedByUserId: req.user.id,
    }).catch(() => {});

    // 4) Dashboard-metrics extraction still runs off the on-disk file (saved by
    //    the RAG /index), in the background so the response isn't blocked.
    upsertStatus(req.user.id, filename, { status: "pending", included: true })
      .catch(() => {})
      .finally(() => {
        extractAndStore(req.user.id, filename).catch(() => {});
      });

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
    const doc = await createDocument(orgId, req.user.id, {
      fileName: filename,
      storagePath: `uploads/${filename}`,
      mimeType: "application/pdf",
    });

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
    await grantAccess({
      documentId: doc.id,
      accessType: "USER",
      userId: req.user.id,
      grantedByUserId: req.user.id,
    }).catch(() => {});

    return res.json({ document_id: doc.id, ...data });
  } catch (err) {
    return next(err);
  }
});

// ── GET /api/rag/documents ────────────────────────────────────────────────────
router.get("/documents", requireAuth, async (req, res, next) => {
  try {
    const response = await fetch(`${RAG_URL}/documents`);
    return res.json(await response.json());
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
