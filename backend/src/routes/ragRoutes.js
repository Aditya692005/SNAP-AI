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

    const response = await fetch(`${RAG_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        session_id: `user_${req.user.id}`,
        source: source || null,
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

    const form = new FormData();
    form.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    const response = await fetch(`${RAG_URL}/upload`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ message: err.detail || "Upload failed" });
    }

    const data = await response.json();

    // Auto-extract dashboard metrics in the background so the upload response
    // isn't blocked by an LLM call. The dashboard shows 'pending' until done.
    const filename = data.filename || req.file.originalname;
    upsertStatus(req.user.id, filename, { status: "pending", included: true })
      .catch(() => {})
      .finally(() => {
        extractAndStore(req.user.id, filename).catch(() => {});
      });

    return res.json(data);
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

    const response = await fetch(`${RAG_URL}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ message: err.detail || "Ingest failed" });
    }

    return res.json(await response.json());
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
