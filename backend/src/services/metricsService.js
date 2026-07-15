// src/services/metricsService.js
//
// Bridges the RAG service's metric extraction with Supabase storage. Used both
// when a document is uploaded (auto-extract) and when the user clicks Recompute.

const fetch = require("node-fetch");
const { replaceDocumentMetrics, upsertStatus } = require("../models/metricsModel");
const { listMetricDefinitions } = require("../models/metricDefinitionsModel");
const {
  getOrCreateDefaultDashboard,
  metricKeysOnDashboard,
  addWidget,
} = require("../models/dashboardModel");

const RAG_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";

// "customer_churn" -> "Customer Churn"
function prettyLabel(key) {
  return String(key).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Fold extracted keys onto tracked metric definitions ───────────────────────
// The RAG prompt asks the model to reuse a user's tracked metric keys, but model
// naming drifts ("royalties" -> "royalty_income", "interest_income" -> "interest").
// When that happens the extracted metric lands under a different key and spawns a
// duplicate KPI card instead of filling the one the user created. This remaps an
// extracted key onto a tracked definition it clearly refers to, deterministically.
const _CANON_STOP = new Set(["total", "net", "gross", "the", "of", "per", "a", "an", "and", "for"]);

// Crude singularizer so plural/singular keys match (royalties<->royalty, expenses<->expense).
function _singular(tok) {
  if (tok.length > 4 && tok.endsWith("ies")) return `${tok.slice(0, -3)}y`;
  if (tok.length > 4 && tok.endsWith("ses")) return tok.slice(0, -2);
  if (tok.length > 3 && tok.endsWith("s") && !tok.endsWith("ss")) return tok.slice(0, -1);
  return tok;
}

// Meaningful tokens of a key/label: lowercased, singularized, stop-words dropped.
function _tokens(str) {
  return String(str || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(_singular)
    .filter((t) => t && !_CANON_STOP.has(t));
}

function _isSubset(a, b) {
  return a.every((t) => b.includes(t));
}

// Generic value-type qualifiers that describe the SAME concept rather than a
// distinct one. Used so "royalty_income" still folds into a "royalties" metric
// (extra token "income" is a qualifier) while "advertising_revenue" does NOT
// fold into a generic "revenue" metric (extra token "advertising" is a real,
// distinguishing concept word).
const _QUALIFIER = new Set([
  "income", "revenue", "amount", "value", "fee", "fees", "sale", "earning",
  "earnings", "cost", "spend", "spending", "expense", "rate", "ratio", "count",
  "number", "num", "monthly", "quarterly", "annual", "yearly", "year", "ytd",
  "avg", "average", "mean", "share", "volume", "paid", "earned", "received",
  // Past-participle fillers that show up in spreadsheet column headers
  // ("Revenue Generated", "Sales Closed", "Profit Recorded") — the melted key
  // should still fold onto a "Revenue"/"Sales"/"Profit" definition.
  "generated", "made", "achieved", "reported", "recorded", "closed", "booked",
]);

// Best tracked definition an extracted key refers to, or null. Matches when the
// extracted key is a shorter form of the definition ("interest" -> "interest
// income"), an exact token match, or a MORE specific form whose only extra words
// are generic qualifiers ("royalty income" -> "royalties"). Always requires a
// shared distinctive (>=4 char) token so nothing merges on tiny/generic words.
function _matchDefinition(metricKey, defs) {
  const ex = _tokens(metricKey);
  if (!ex.length) return null;
  let best = null;
  let bestScore = 0;
  for (const d of defs) {
    for (const cand of [d.key, d.label]) {
      const dt = _tokens(cand);
      if (!dt.length) continue;
      const exSubDef = _isSubset(ex, dt); // extracted is a shorter/equal form of the def
      const defSubEx = _isSubset(dt, ex); // extracted is more specific than the def
      let ok = exSubDef;
      if (!ok && defSubEx) {
        const extra = ex.filter((t) => !dt.includes(t));
        ok = extra.every((t) => _QUALIFIER.has(t) || _CANON_STOP.has(t));
      }
      if (!ok) continue;
      const shared = dt.filter((t) => ex.includes(t));
      if (!shared.some((t) => t.length >= 4)) continue;
      const exact = exSubDef && defSubEx;
      // Prefer exact, then the most specific (most shared tokens) definition.
      const score = (exact ? 1000 : 0) + shared.length * 10 + Math.min(dt.length, ex.length);
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
  }
  return best;
}

// Rewrite each extracted metric's key to the tracked definition it matches, so an
// upload POPULATES that metric's existing card instead of spawning a duplicate.
function canonicalizeToDefinitions(metrics, defs) {
  const usable = (defs || []).filter((d) => d && d.key);
  if (!metrics.length || !usable.length) return metrics;
  for (const m of metrics) {
    if (!m.metric) continue;
    const d = _matchDefinition(m.metric, usable);
    if (d && d.key !== m.metric) m.metric = d.key;
  }
  return metrics;
}

// Ensure the user's DEFAULT board has a metric card for every newly discovered
// metric key. Keys that already have a card (live OR trashed) are skipped, so a
// metric the user removed doesn't keep coming back. Returns the widgets added,
// which the caller surfaces to the client for the "added metrics — undo" toast.
async function autoAddMetricWidgets(userId, organizationId, metrics) {
  if (!metrics || metrics.length === 0) return [];
  const board = await getOrCreateDefaultDashboard(userId, organizationId);
  const existing = await metricKeysOnDashboard(board.id);
  const kindByKey = new Map();
  for (const m of metrics) {
    if (m.metric && !kindByKey.has(m.metric)) kindByKey.set(m.metric, m.kind || "number");
  }
  const added = [];
  for (const [key, kind] of kindByKey) {
    if (existing.has(key)) continue;
    const label = prettyLabel(key);
    const widget = await addWidget(board.id, {
      widget_type: "metric",
      title: label,
      config: { metric_key: key, kind, label },
    });
    added.push(widget);
    existing.add(key);
  }
  return added;
}

// Extract metrics for one document from the RAG service and store them, tagged
// with the document/org so they aggregate at any dashboard scope. The user's
// tracked metric definitions steer extraction (the LLM looks for them).
// Returns { ok, count, metrics } — never throws, so callers (e.g. upload)
// aren't broken by extraction/quota failures; the document is marked 'error'.
async function extractAndStore(userId, source, opts = {}) {
  const { documentId = null, organizationId = null } = opts;
  try {
    // Best-effort: before metric_definitions is deployed this stays [] and
    // extraction is purely open-ended.
    let customMetrics = [];
    try {
      customMetrics = (await listMetricDefinitions("PERSONAL", userId)).map((d) => ({
        key: d.metric_key,
        label: d.label,
        kind: d.kind,
        description: d.description,
      }));
    } catch {
      /* metric_definitions table not available */
    }

    // document_id, not just the file name: the RAG service fetches the original bytes
    // from Storage by resolving the id to a storage_path. Resolving by name alone was
    // ambiguous across organizations — two orgs with a `report.pdf` would extract each
    // other's numbers.
    const response = await fetch(`${RAG_URL}/extract-metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, document_id: documentId, custom_metrics: customMetrics }),
    });

    if (!response.ok) {
      await upsertStatus(userId, source, { status: "error" });
      return { ok: false, count: 0, metrics: [] };
    }

    const data = await response.json();
    // Fold any drifted keys back onto the user's tracked metrics BEFORE storing,
    // so the data lands on the card they created rather than a duplicate. Also
    // means autoAddMetricWidgets (which skips existing keys) won't add a new card.
    const metrics = canonicalizeToDefinitions(
      data.metrics || [],
      customMetrics.map((c) => ({ key: c.key, label: c.label }))
    );
    await replaceDocumentMetrics(userId, source, metrics, { documentId, organizationId });
    return { ok: true, count: metrics.length, metrics };
  } catch {
    try {
      await upsertStatus(userId, source, { status: "error" });
    } catch {
      // ignore — best effort
    }
    return { ok: false, count: 0, metrics: [] };
  }
}

module.exports = { extractAndStore, autoAddMetricWidgets, canonicalizeToDefinitions };
