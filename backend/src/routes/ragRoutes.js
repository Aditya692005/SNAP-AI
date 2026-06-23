// backend/src/routes/ragRoutes.js
//
// Proxies /api/rag/* → Python RAG service at http://localhost:8000
// Mount in server.js:  app.use("/api/rag", ragRoutes);

const express = require("express");
const multer = require("multer");
const FormData = require("form-data");
const fetch = require("node-fetch");

const requireAuth = require("../middleware/requireAuth");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const RAG_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";

// ── POST /api/rag/chat ────────────────────────────────────────────────────────
router.post("/chat", requireAuth, async (req, res, next) => {
  try {
    const { message, session_id } = req.body;
    if (!message) return res.status(400).json({ message: "message is required" });

    const response = await fetch(`${RAG_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        session_id: session_id || `user_${req.user.id}`,
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
router.delete("/documents", requireAuth, async (req, res, next) => {
  try {
    const response = await fetch(`${RAG_URL}/documents`, { method: "DELETE" });
    return res.json(await response.json());
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
