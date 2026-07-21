// src/services/metricsService.js
//
// Bridges the RAG service's metric extraction with Supabase storage. Used both
// when a document is uploaded (auto-extract) and when the user clicks Recompute.

const fetch = require("node-fetch");
const { replaceDocumentMetrics, upsertStatus } = require("../models/metricsModel");

const RAG_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";

// Extract metrics for one document from the RAG service and store them.
// Returns { ok, count } — never throws, so callers (e.g. upload) aren't broken
// by extraction/quota failures; the document is just marked 'error'.
async function extractAndStore(userId, source) {
  try {
    const response = await fetch(`${RAG_URL}/extract-metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });

    if (!response.ok) {
      await upsertStatus(userId, source, { status: "error" });
      return { ok: false, count: 0 };
    }

    const data = await response.json();
    const metrics = data.metrics || [];
    await replaceDocumentMetrics(userId, source, metrics);
    return { ok: true, count: metrics.length };
  } catch {
    try {
      await upsertStatus(userId, source, { status: "error" });
    } catch {
      // ignore — best effort
    }
    return { ok: false, count: 0 };
  }
}

module.exports = { extractAndStore };
