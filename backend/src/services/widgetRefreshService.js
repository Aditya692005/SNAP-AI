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

const { ragFetch } = require("../utils/ragClient");
const { findMessageById, listMessages } = require("../models/conversationModel");
const {
  getWidgetForUser,
  listWidgetsForUser,
  updateWidget,
} = require("../models/dashboardModel");
const {
  updateWidgetVersioned,
  listDepartmentWidgetsForOrganization,
  updateWidgetConfigUnversioned,
  touchBoard,
} = require("../models/departmentDashboardModel");

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
// organizationId scopes the on-disk file lookup to that tenant's uploads dir.
async function regenerateSpec(instruction, source, organizationId) {
  const response = await ragFetch(
    "/visualize",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction,
        source: source || null,
        organization_id: organizationId || null,
      }),
    },
    120000
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.detail || "Visualization failed");
  }
  return response.json();
}

// Regenerate ONE widget's chart from fresh data and clear its stale flag.
// Returns the updated widget. Throws if it can't be refreshed (no link/instruction).
async function refreshWidget(userId, organizationId, widgetId) {
  const widget = await getWidgetForUser(userId, widgetId);
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
  const spec = await regenerateSpec(recovered.instruction, source, organizationId);

  const config = { ...(widget.config || {}), spec };
  delete config.stale;
  delete config.stale_source;
  return updateWidget(widget.personal_dashboard_id, widgetId, { config });
}

// Regenerate ONE department-board widget from fresh data, version-guarded so a
// concurrent editor isn't clobbered. `widget` is the already-fetched+authorized
// widget row; `expectedVersion` is the client's last-seen version; `userId`
// records who refreshed it. Throws (404/422/409-tagged) if it can't refresh.
async function refreshDepartmentWidget(widget, expectedVersion, userId, organizationId) {
  const recovered = await recoverRequest(widget.ai_message_id);
  if (!recovered) {
    const e = new Error("This chart can't be refreshed automatically — it isn't linked to a chat request.");
    e.status = 422;
    throw e;
  }
  const source = widget.config?.stale_source || recovered.sources[0] || null;
  const spec = await regenerateSpec(recovered.instruction, source, organizationId);

  const config = { ...(widget.config || {}), spec };
  delete config.stale;
  delete config.stale_source;
  const updated = await updateWidgetVersioned(widget.id, expectedVersion, { config });
  touchBoard(widget.department_dashboard_id, userId); // audit only, best-effort
  return updated;
}

// After a same-named file is re-uploaded, flag every DEPARTMENT-board widget in
// the org charted from that file as stale, so any editor of the board can
// refresh it — not just the pinner. Best-effort; never throws. Returns the
// count flagged. Un-versioned (system op): see updateWidgetConfigUnversioned.
async function markDepartmentWidgetsStaleForSource(organizationId, source) {
  try {
    const widgets = await listDepartmentWidgetsForOrganization(organizationId);
    let flagged = 0;
    for (const w of widgets) {
      if (w.widget_type !== "ai_chart" || !w.ai_message_id) continue;
      const recovered = await recoverRequest(w.ai_message_id);
      if (!recovered || !recovered.sources.includes(source)) continue;
      const config = { ...(w.config || {}), stale: true, stale_source: source };
      await updateWidgetConfigUnversioned(w.id, config);
      flagged += 1;
    }
    return flagged;
  } catch {
    return 0;
  }
}

// After a same-named file is re-uploaded, flag every widget charted from that
// file as stale so the UI can offer a refresh. Best-effort; never throws.
// Returns the number of widgets flagged.
async function markWidgetsStaleForSource(userId, organizationId, source) {
  try {
    const widgets = await listWidgetsForUser(userId);
    let flagged = 0;
    for (const w of widgets) {
      if (w.widget_type !== "ai_chart" || !w.ai_message_id) continue;
      const recovered = await recoverRequest(w.ai_message_id);
      if (!recovered || !recovered.sources.includes(source)) continue;
      const config = { ...(w.config || {}), stale: true, stale_source: source };
      await updateWidget(w.personal_dashboard_id, w.id, { config });
      flagged += 1;
    }
    return flagged;
  } catch {
    return 0;
  }
}

module.exports = {
  refreshWidget,
  markWidgetsStaleForSource,
  refreshDepartmentWidget,
  markDepartmentWidgetsStaleForSource,
};
