// backend/src/routes/ragRoutes.js
//
// Proxies /api/rag/* → Python RAG service at http://localhost:8000
// Mount in server.js:  app.use("/api/rag", ragRoutes);

const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const FormData = require("form-data");

const { ragFetch } = require("../utils/ragClient");
const requireAuth = require("../middleware/requireAuth");
const requirePermission = require("../middleware/requirePermission");
const {
  markWidgetsStaleForSource,
  markDepartmentWidgetsStaleForSource,
  markOrganizationWidgetsStaleForSource,
} = require("../services/widgetRefreshService");
const { extractAndStore, autoAddMetricWidgets } = require("../services/metricsService");
const { upsertStatus, getStatus, clearAllForUser } = require("../models/metricsModel");
const {
  createDocument,
  setDocumentStatus,
  resetDocumentForReupload,
  accessibleDocumentIds,
  findByFileName,
  findByContentHash,
  findDocumentById,
  deleteAllForUser,
  listStoragePathsForUser,
} = require("../models/documentModel");
const {
  documentKey,
  generatedKey,
  inferMimeType,
  putObject,
  getObject,
  removeObjects,
  removePrefix,
} = require("../services/storageService");
const { canRead, sendBuffer } = require("../services/documentDownload");
const {
  createConversation,
  findConversation,
  setConversationDocumentIds,
  listMessages,
  addMessage,
  deleteMessage,
  recordRetrievedChunks,
} = require("../models/conversationModel");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

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

// Reduce a chronological message list to well-formed user→assistant exchanges.
// A turn whose answer never got saved (the LLM/RAG call failed, or persisting the
// answer hiccuped) leaves the question behind as a dangling USER message. Feeding
// that back to the LLM makes it answer the stale question again alongside the new
// one — so keep a USER turn only when it's immediately followed by its AI reply,
// and drop any unpaired message. This also repairs threads already corrupted by a
// past failure, since history is rebuilt from the DB on every turn.
function pairExchanges(history) {
  const paired = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const next = history[i + 1];
    if (m.role === "user" && next && next.role === "assistant") {
      paired.push(m, next);
      i++; // consume the paired assistant reply
    }
    // A user with no following assistant (failed/unanswered turn) or a stray
    // assistant with no preceding user is dropped.
  }
  return paired;
}

// "create a metric of X" / "track X as a KPI" — the user wants a tracked KPI, not
// a one-off answer. Detected here so the chat returns a metric PROPOSAL the client
// can add to a dashboard, instead of the RAG service just answering with a number.
// Kept deliberately explicit so ordinary questions ("what is our revenue?") don't
// trip it — it needs an action verb next to the word metric/kpi.
const METRIC_INTENT_RE =
  /\b(create|make|add|define|track|set up|start tracking)\b[^.?!]{0,40}\b(metric|kpi|kpis)\b|\bkpi\b[^.?!]{0,20}\bfor\b/i;

function wantsMetric(message) {
  return METRIC_INTENT_RE.test(message || "");
}

// Pull the KPI name + value kind out of a "create a metric" request. Heuristic
// (no LLM call): strip the intent phrasing to get the metric's name, and infer
// the kind from money/percent/count keywords. Good enough for the common
// phrasings; the user can rename the card on the dashboard afterwards.
function parseMetricRequest(message) {
  const raw = String(message || "");
  let label = raw
    .replace(/\b(can|could|would|will|please)\b/gi, " ")
    .replace(/\byou\b/gi, " ")
    .replace(/\b(create|make|add|define|track|set up|start tracking)\b/gi, " ")
    .replace(/\b(a|an|new)\b/gi, " ")
    .replace(/\b(metric|kpi|kpis)\b/gi, " ")
    .replace(/\b(of|for|called|named|to track|that tracks|to|on|the|as)\b/gi, " ")
    .replace(/[?."'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!label) label = "New metric";
  label = label.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);

  const lower = raw.toLowerCase();
  let kind = "number";
  if (/\b(revenue|sales|cost|price|profit|income|expense|spend|budget|dollar|usd|eur|gbp|amount|\$)\b/.test(lower)) {
    kind = "currency";
  } else if (/\b(rate|percent|percentage|margin|ratio|churn|growth|share|%)\b/.test(lower)) {
    kind = "percent";
  } else if (/\b(count|number of|volume|quantity|headcount|users|customers|orders|units|#)\b/.test(lower)) {
    kind = "count";
  }

  const metricKey =
    label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "new_metric";
  return { metric_key: metricKey, label, kind };
}

// The AI-assistant surface (chat + its preview + re-indexing a generated
// report) is gated by USE_AI_ASSISTANT. Deliberately NOT gated: /upload and
// /download (the Documents page uses them) and /visualize (dashboard chart
// refresh uses it).
router.post("/chat", requireAuth, requirePermission("USE_AI_ASSISTANT"), async (req, res, next) => {
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
    const priorMessages = (await listMessages(convo.id))
      .filter((m) => m.sender_type === "USER" || m.sender_type === "AI")
      .map((m) => ({
        role: m.sender_type === "USER" ? "user" : "assistant",
        content: m.content,
      }));
    // Pair BEFORE trimming so the cap never slices a paired reply off its
    // question, and so any dangling unanswered turn is excluded from memory.
    const history = pairExchanges(priorMessages).slice(-MAX_HISTORY_MESSAGES);

    // Persist the user's question BEFORE the (slow) LLM call. If the client
    // navigates away before the answer returns, the request still completes
    // here, so the question is never lost from the thread — reopening the
    // conversation shows it, and the answer once it's saved below. History was
    // built above from prior messages, so this new one isn't double-counted.
    const userMsg = await addMessage(convo.id, "USER", message).catch(() => null);

    // A turn that fails before an answer is produced must NOT leave the question
    // behind as a dangling, unanswered turn — otherwise the next request's
    // history would feed it back to the LLM, which then answers this failed
    // question again alongside the new one. Roll it back on any failure below
    // (RAG error status, or the RAG service being unreachable). Once an answer is
    // successfully produced, `answered` flips true and the question stays put.
    let answered = false;
    const rollbackQuestion = async () => {
      if (userMsg?.id && !answered) await deleteMessage(userMsg.id).catch(() => {});
    };

    let data;
    if (wantsMetric(message)) {
      // Metric-creation intent: don't spend an LLM answer on it. Return a metric
      // PROPOSAL the client renders with an "Add to dashboard" action; the actual
      // definition + KPI card are created by /api/dashboard/track-metric when the
      // user places it. This is why asking used to "just give a number back".
      const metric = parseMetricRequest(message);
      data = {
        answer:
          `I can track **${metric.label}** as a metric. Use **Add to dashboard** below to ` +
          `start tracking it — the value fills in as your documents are read.`,
        metric,
        sources: [],
        doc_count: 0,
      };
    } else {
      let response;
      try {
        response = await ragFetch(
          "/chat",
          {
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
          },
          180000 // condense + retrieval + generation can legitimately take a while
        );
      } catch (err) {
        await rollbackQuestion(); // RAG service unreachable
        throw err;
      }

      if (!response.ok) {
        await rollbackQuestion();
        const err = await response.json().catch(() => ({}));
        return res.status(response.status).json({ message: err.detail || "RAG service error" });
      }
      data = await response.json();
    }

    answered = true; // an answer was produced; keep the question in the thread

    // Anchor the thread's document scope on its first explicitly-scoped answer
    // (user's drawer pick or the preview's auto-match). Follow-up turns reuse
    // this scope client-side, so the conversation stays about the same docs.
    // Only-sets-when-NULL semantics live in the model; best-effort on purpose.
    if (selected && documentIds.length > 0) {
      setConversationDocumentIds(convo.id, documentIds).catch(() => {});
    }

    // Persist the AI answer (the question was already saved above). Best-effort:
    // a storage hiccup must not eat the answer.
    let aiMessageId = null;
    try {
      const metadata = {};
      if (data.sources?.length) metadata.sources = data.sources;
      if (data.chart) metadata.chart = data.chart;
      if (data.document) metadata.document = data.document;
      if (data.metric) metadata.metric = data.metric; // metric proposal, re-addable after reload
      // Persist a slim citation list (source + page + span) so provenance chips
      // survive a reload, not just the live response.
      if (data.retrieved?.length) {
        metadata.citations = data.retrieved.map((r) => ({
          document_id: r.document_id,
          file_name: r.file_name,
          page: r.page,
          char_start: r.char_start,
          char_end: r.char_end,
          similarity: r.similarity,
        }));
      }
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
router.post("/chat/preview", requireAuth, requirePermission("USE_AI_ASSISTANT"), async (req, res, next) => {
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

    const response = await ragFetch(
      "/retrieve-preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, organization_id: orgId, document_ids: documentIds }),
      },
      30000
    );
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

    // organization_id scopes the RAG service's filename -> storage_path lookup. `source`
    // is only a file name, which is ambiguous system-wide; without the org it could
    // resolve to a same-named document belonging to another tenant.
    const response = await ragFetch(
      "/visualize",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction,
          source: source || null,
          organization_id: req.user.organization_id,
        }),
      },
      120000
    );

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
    // Clients don't reliably send a real content type (curl and some browsers say
    // octet-stream for everything); resolve it from the extension once and use it
    // everywhere below — the bucket may enforce a MIME whitelist, and downloads
    // echo this value back as the response Content-Type.
    const mimeType = inferMimeType(filename, req.file.mimetype);

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

    // 1) Decide whether this is a new document or an UPDATE of an existing one.
    //    A same-named document may already exist — vectors and dashboard metrics
    //    key on the filename, so uploading it again is an UPDATE of that document,
    //    never a silent duplicate. Unless the client already confirmed the update
    //    (overwrite=true), reply 409 so it can ask the user to update the existing
    //    document or rename the new file. Updating follows the delete rule: only
    //    the uploader or an org_admin.
    const existing = await findByFileName(orgId, filename);
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
    }

    // 2) Persist the ORIGINAL bytes to Supabase Storage — the store of record.
    //    The id is minted here rather than by Postgres because the key embeds it and
    //    we want the bytes safely stored BEFORE the row exists: if this upload fails,
    //    no row is created, so the user never sees a document that can't be opened.
    //    A re-upload reuses the existing id, so it resolves to the same key and
    //    overwrites in place instead of stacking a second copy.
    const documentId = existing ? existing.id : crypto.randomUUID();
    const storagePath = documentKey(orgId, documentId, filename);
    await putObject(storagePath, req.file.buffer, mimeType);

    // 3) Register (or reset) the document row.
    let doc = existing;
    if (existing) {
      // Reuse the row: the RAG service clears this document_id's old chunks/tables
      // before re-indexing, so the content is replaced in place.
      await resetDocumentForReupload(existing.id, {
        mimeType,
        fileSize: req.file.size,
        contentHash,
        storagePath,
      });
    } else {
      doc = await createDocument(orgId, req.user.id, {
        id: documentId,
        fileName: filename,
        storagePath,
        mimeType,
        fileSize: req.file.size,
        contentHash,
      });
    }

    // 4) Send the file to the RAG service (it gets the bytes directly — no reason
    //    to re-fetch what we already hold in memory). Indexing runs as a
    //    BACKGROUND job there — this returns as soon as the bytes are spooled and
    //    the job queued. The RAG service owns documents.status from here
    //    (PROCESSING → PROCESSED/FAILED); poll GET /api/rag/index-status/:documentId
    //    or the documents list to see it land.
    const form = new FormData();
    form.append("file", req.file.buffer, { filename, contentType: mimeType });
    form.append("document_id", doc.id);
    form.append("organization_id", orgId);

    const response = await ragFetch(
      "/index",
      { method: "POST", body: form, headers: form.getHeaders() },
      60000 // just save + enqueue; the heavy work happens in the background job
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      // Row stays PROCESSING; the file can be re-indexed later.
      return res.status(response.status).json({ message: err.detail || "Indexing failed" });
    }
    const data = await response.json();
    if (data.chunks != null) {
      // Older RAG service that still indexes synchronously.
      await setDocumentStatus(doc.id, "PROCESSED");
    }
    // No document_access self-grant: the uploader can already see their own
    // documents via uploaded_by_user_id, and a grant row would (wrongly) show
    // them in the document's "Shared with" list.

    // 5) Record the document's dashboard status. Metric extraction is NOT run on
    //    upload — the dashboard shows only pinned AI charts, so there's no metrics
    //    view to feed and we don't want to spend an LLM call per upload. If a file
    //    of the same name was uploaded before, this is an UPDATE: flag any pinned
    //    charts built from it as stale so the user can refresh them (their Refresh
    //    button reruns /visualize against the now-updated file).
    const isReupload = !!(await getStatus(req.user.id, filename).catch(() => null));
    upsertStatus(req.user.id, filename, { status: "ready", included: true }).catch(() => {});
    if (isReupload) {
      markWidgetsStaleForSource(req.user.id, orgId, filename).catch(() => {});
    }

    // Extract dashboard metrics in the background (open-ended + the user's
    // tracked definitions), tagged with this document/org so they aggregate at
    // any scope, then auto-add a KPI card for each newly discovered metric on
    // the default board. The client polls /recent-widgets to show an
    // "added metrics — undo" toast.
    extractAndStore(req.user.id, filename, { documentId: doc.id, organizationId: orgId })
      .then((r) => {
        if (r.ok && r.metrics.length) {
          return autoAddMetricWidgets(req.user.id, orgId, r.metrics);
        }
      })
      .catch(() => {});
    // Department and organization boards are shared, so an UPDATE by ANY member
    // (org-level re-upload, detected above via findByFileName → `existing`) must
    // flag their charts stale — not just the re-uploader's own personal charts.
    if (existing) {
      markDepartmentWidgetsStaleForSource(orgId, filename).catch(() => {});
      markOrganizationWidgetsStaleForSource(orgId, filename).catch(() => {});
    }

    return res.json({ document_id: doc.id, filename, ...data });
  } catch (err) {
    return next(err);
  }
});

// ── POST /api/rag/ingest ──────────────────────────────────────────────────────
// Indexes an AI-generated report so the AI can answer questions about it — the
// "Add to AI" action. The PDF is already in Storage under the org's `generated/`
// prefix (the RAG service put it there when it built it); this gives it a documents
// row so it becomes a first-class, shareable, searchable document.
router.post("/ingest", requireAuth, requirePermission("USE_AI_ASSISTANT"), async (req, res, next) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ message: "filename is required" });
    const orgId = req.user.organization_id;

    // The generated PDF keeps its `generated/<org>/<name>` key rather than being copied
    // to a `<org>/<doc>/<name>` one: storage_path is authoritative everywhere, so nothing
    // downstream cares which prefix a document's bytes happen to live under.
    const storagePath = generatedKey(orgId, filename);

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
      await resetDocumentForReupload(existing.id, { mimeType: "application/pdf", storagePath });
    } else {
      doc = await createDocument(orgId, req.user.id, {
        id: crypto.randomUUID(),
        fileName: filename,
        storagePath,
        mimeType: "application/pdf",
      });
    }

    const response = await ragFetch(
      "/ingest",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, document_id: doc.id, organization_id: orgId }),
      },
      300000 // synchronous parse + embed (+ per-table LLM summaries)
    );
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

// ── GET /api/rag/index-status/:documentId ─────────────────────────────────────
// Indexing progress for a document ('processing' | 'done' | 'failed' |
// 'unknown' after a RAG-service restart — fall back to the documents list's
// status column in that case). Org-checked so users can't probe other tenants.
router.get("/index-status/:documentId", requireAuth, async (req, res, next) => {
  try {
    const doc = await findDocumentById(req.params.documentId);
    if (!doc || doc.organization_id !== req.user.organization_id) {
      return res.status(404).json({ message: "Document not found." });
    }
    const response = await ragFetch(
      `/index-status/${encodeURIComponent(req.params.documentId)}`,
      {},
      10000
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ message: err.detail || "RAG service error" });
    }
    const data = await response.json();
    // documents.status is authoritative once the job record is gone (restart).
    return res.json({ ...data, document_status: doc.status });
  } catch (err) {
    return next(err);
  }
});

// ── DELETE /api/rag/documents ─────────────────────────────────────────────────
// Removes this user's documents everywhere: the stored originals, the documents rows
// (which cascade to chunks/tables/access), their dashboard metrics, and the RAG
// service's local cache. The dashboard resets to "no data yet".
router.delete("/documents", requireAuth, async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;

    // Collect the storage keys BEFORE deleting the rows — once they're gone there is no
    // way left to find their objects, and the bucket would silently fill with orphans.
    const keys = await listStoragePathsForUser(req.user.id, orgId).catch(() => []);

    // The RAG service only drops its local file cache + chat history here; the
    // durable copies (bucket objects, rows) are removed below.
    const response = await ragFetch(
      `/documents?organization_id=${encodeURIComponent(orgId)}`,
      { method: "DELETE" },
      30000
    );
    const data = await response.json();
    await clearAllForUser(req.user.id);
    await deleteAllForUser(req.user.id, orgId).catch(() => {});

    // Objects last, best-effort: an orphaned object is invisible garbage, whereas a row
    // whose bytes we already deleted would be a document the user can't open.
    await removeObjects(keys).catch(() => {});
    await removePrefix(`generated/${orgId}`).catch(() => {});

    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

// ── GET /api/rag/download/:filename ───────────────────────────────────────────
// Streams a document's ORIGINAL bytes back to the client, from Supabase Storage.
//
// This route used to proxy to the RAG service, which handed back any file sitting in
// its uploads/ directory — it verified you were logged in, but never that you could see
// *that* document, so any user could pull any other org's file by name. It now resolves
// the name to a real document in the caller's own org and checks access.
//
// Kept keyed by filename because that's all the client has for a cited source or a
// freshly generated report; GET /api/documents/:id/download is the canonical form.
router.get("/download/:filename", requireAuth, async (req, res, next) => {
  try {
    const filename = req.params.filename;
    const orgId = req.user.organization_id;

    // 1) An uploaded document — must exist in the caller's org AND be one they can read.
    //    A document they can't read is reported as missing, not forbidden: whether a file
    //    of a given name exists in another org isn't theirs to learn.
    const doc = await findByFileName(orgId, filename);
    if (doc) {
      if (!(await canRead(req, doc.id))) {
        return res.status(404).json({ message: "Document not found." });
      }
      const buf = await getObject(doc.storage_path);
      return sendBuffer(res, buf, doc.file_name, doc.mime_type);
    }

    // 2) An AI-generated report that hasn't been "Add to AI"-ed yet, so it has no
    //    documents row and can only be found by name. Safe to serve on name alone: the
    //    key is built from the caller's own organization_id, so it cannot reach another
    //    org's file, and a generated report only ever contains content from documents
    //    this user could already read.
    try {
      const buf = await getObject(generatedKey(orgId, filename));
      return sendBuffer(res, buf, filename, "application/pdf");
    } catch {
      /* not a generated report either — fall through to 404 */
    }

    return res.status(404).json({ message: "Document not found." });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
