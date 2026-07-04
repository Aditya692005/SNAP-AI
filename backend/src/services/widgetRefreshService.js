// src/services/widgetRefreshService.js
//
// Keeps pinned AI-chart widgets in step with re-uploaded data.
//
// A pinned "ai_chart" widget stores a SNAPSHOT of the chart (config.spec) plus
// `ai_message_id` — a link back to the AI message that generated it. From that
// message we can recover the original request (the preceding USER message) and
// which document(s) it charted (metadata.sources), so the chart can be
// regenerated against fresh data by re-running /visualize.
//
// Refresh is MANUAL: on re-upload we only flag affected widgets stale
// (config.stale). The user clicks "refresh" on the widget to actually rerun the
// LLM, so we never silently spend on regeneration.

const fetch = require("node-fetch");
const { findMessageById, listMessages } = require("../models/conversationModel");
const {
  getOrCreateDefaultDashboard,
  listWidgets,
  updateWidget,
} = require("../models/dashboardModel");

const RAG_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";

// Recover {instruction, sources} for a pinned chart from the AI message it came
// from. instruction = the USER message immediately before that AI message.
// Returns null if the link is missing/unusable.
async function recoverRequest(aiMessageId) {
  if (!aiMessageId) return null;
  const msg = await findMessageById(aiMessageId);
  if (!msg || msg.sender_type !== "AI") return null;
  const sources = Array.isArray(msg.metadata?.sources) ? msg.metadata.sources : [];

  const all = await listMessages(msg.conversation_id);
  const idx = all.findIndex((m) => m.id === msg.id);
  let instruction = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (all[i].sender_type === "USER") {
      instruction = all[i].content;
      break;
    }
  }
  if (!instruction) return null;
  return { instruction, sources };
}

// Ask the RAG service to rebuild a chart spec for `instruction` against `source`.
async function regenerateSpec(instruction, source) {
  const response = await fetch(`${RAG_URL}/visualize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, source: source || null }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.detail || "Visualization failed");
  }
  return response.json();
}

// Regenerate ONE widget's chart from fresh data and clear its stale flag.
// Returns the updated widget. Throws if it can't be refreshed (no link/instruction).
async function refreshWidget(userId, organizationId, widgetId) {
  const dashboard = await getOrCreateDefaultDashboard(userId, organizationId);
  const widgets = await listWidgets(dashboard.id);
  const widget = widgets.find((w) => w.id === widgetId);
  if (!widget) {
    const e = new Error("Widget not found");
    e.status = 404;
    throw e;
  }
  const recovered = await recoverRequest(widget.ai_message_id);
  if (!recovered) {
    const e = new Error("This chart can't be refreshed automatically — it isn't linked to a chat request.");
    e.status = 422;
    throw e;
  }
  // Prefer the source flagged stale (the re-uploaded file); else the first source.
  const source = widget.config?.stale_source || recovered.sources[0] || null;
  const spec = await regenerateSpec(recovered.instruction, source);

  const config = { ...(widget.config || {}), spec };
  delete config.stale;
  delete config.stale_source;
  return updateWidget(dashboard.id, widgetId, { config });
}

// After a same-named file is re-uploaded, flag every widget charted from that
// file as stale so the UI can offer a refresh. Best-effort; never throws.
// Returns the number of widgets flagged.
async function markWidgetsStaleForSource(userId, organizationId, source) {
  try {
    const dashboard = await getOrCreateDefaultDashboard(userId, organizationId);
    const widgets = await listWidgets(dashboard.id);
    let flagged = 0;
    for (const w of widgets) {
      if (w.widget_type !== "ai_chart" || !w.ai_message_id) continue;
      const recovered = await recoverRequest(w.ai_message_id);
      if (!recovered || !recovered.sources.includes(source)) continue;
      const config = { ...(w.config || {}), stale: true, stale_source: source };
      await updateWidget(dashboard.id, w.id, { config });
      flagged += 1;
    }
    return flagged;
  } catch {
    return 0;
  }
}

module.exports = { refreshWidget, markWidgetsStaleForSource };
