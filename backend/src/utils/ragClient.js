// backend/src/utils/ragClient.js
//
// Single place the backend talks to the Python RAG service from:
//   * base URL (RAG_SERVICE_URL)
//   * a per-call timeout, so a hung RAG service can't pile up backend requests
//   * the optional shared-secret header (RAG_INTERNAL_TOKEN) — set the same
//     value in rag_service/.env if the RAG service is reachable beyond localhost

const fetch = require("node-fetch");

const RAG_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";
const DEFAULT_TIMEOUT_MS = parseInt(process.env.RAG_TIMEOUT_MS || "120000", 10);

// `path` starts with "/" (query string included by the caller when needed).
// node-fetch v2's `timeout` option aborts the request after N ms of inactivity.
function ragFetch(path, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const headers = { ...(options.headers || {}) };
  if (process.env.RAG_INTERNAL_TOKEN) {
    headers["x-internal-token"] = process.env.RAG_INTERNAL_TOKEN;
  }
  return fetch(`${RAG_URL}${path}`, { ...options, headers, timeout: timeoutMs });
}

module.exports = { RAG_URL, ragFetch };
