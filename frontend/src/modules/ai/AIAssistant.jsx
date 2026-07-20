import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AppShell from "../../components/AppShell";
import ToastStack from "../../components/Toast";
import ChartBlock from "./ChartBlock";
import { authService } from "../../services/authService";
import { previewKind, parseCsv } from "../../utils/filePreview";
import "./AIAssistant.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

// Collapse retrieval provenance to one chip per (file, page), keeping the best
// (highest-similarity) span, ordered by relevance. Backs the "Cited from" chips.
function dedupeCitations(citations) {
  const byKey = new Map();
  for (const c of citations || []) {
    const key = `${c.file_name || ""}|${c.page ?? ""}`;
    const prev = byKey.get(key);
    if (!prev || (c.similarity ?? 0) > (prev.similarity ?? 0)) byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
}

// The thread the user last had open, so navigating away and back (which unmounts
// this component and clears its in-memory messages) reopens the same
// conversation instead of dropping the user on a blank chat.
const ACTIVE_CONVO_KEY = "activeConversationId";

const GREETING = {
  role: "assistant",
  text: "Hi! I'm SNAP AI. Upload documents and ask me anything — including \"show me a bar chart of sales by region\" to generate charts, or \"generate a report summarizing this document\" to create a downloadable PDF.",
};

// Requests that SYNTHESIZE across documents — charts, tables, reports,
// comparisons, or an explicit multi-year range — should see ALL of the user's
// data, not just the single best-matching file. Otherwise data split across
// uploads (e.g. 2024-25 in one file, 2026-27 in another) silently goes missing
// from the result. Mirrors the RAG service's wants_chart / wants_table /
// wants_document intent so the scoping matches what the server will do.
const AGGREGATE_INTENT_RE =
  /\b(chart|graph|plot|visuali[sz]e|visuali[sz]ation|diagram|histogram|scatter|pie|doughnut|trend|table|compare|comparison|report|over time|by (year|quarter|month|region|category|department|product))\b|from\s+\d{4}\s+to\s+\d{4}/i;

function wantsAggregate(text) {
  return AGGREGATE_INTENT_RE.test(text || "");
}

function getToken() {
  return localStorage.getItem("token");
}

function authHeaders() {
  return { Authorization: `Bearer ${getToken()}` };
}

function AIAssistant() {
  const [messages, setMessages] = useState([GREETING]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null); // { done, total }
  const [clearing, setClearing] = useState(false);
  const [docList, setDocList] = useState([]);
  const [showDocs, setShowDocs] = useState(false);
  // Docs the user picked for the AI to answer from (empty = search everything).
  const [selectedDocIds, setSelectedDocIds] = useState([]);
  // The thread's established document scope (persisted on ai_conversations).
  // Once the first answer is grounded on specific docs, follow-ups stay scoped
  // to them — a normal conversation doesn't change subject mid-thread. Manual
  // drawer picks (selectedDocIds) always take precedence over this.
  const [conversationDocIds, setConversationDocIds] = useState([]);
  // The scope banner announces itself for 30s (with a countdown line) then
  // gets out of the way — the scope itself stays active, and any scope change
  // brings the banner back for another 30s.
  const [bannerVisible, setBannerVisible] = useState(false);
  // Persisted chat threads (Phase 3).
  const [conversationId, setConversationId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyQuery, setHistoryQuery] = useState(""); // filter for the history drawer
  // Transient popup notifications (auto-dismiss after a few seconds).
  const [toasts, setToasts] = useState([]);
  // Sources side panel: { citations: [...], sources: [...] } for one answer.
  const [sourcesPanel, setSourcesPanel] = useState(null);
  // Citation preview modal: { name, loading, url?, kind?, text?, rows?, error? }
  const [citeViewer, setCiteViewer] = useState(null);
  // "Pin to dashboard" picker: { spec, aiMessageId, dashboards } while choosing.
  const [pinPicker, setPinPicker] = useState(null);
  const [pinningTo, setPinningTo] = useState(null); // dashboard id being pinned to

  const bottomRef = useRef(null);
  const fileRef = useRef(null);
  const toastIdRef = useRef(0);
  // Pending background-index poll timers, so we can cancel them on a new upload
  // or on unmount instead of leaking fetches after the user navigates away.
  const pollTimersRef = useRef([]);

  function notify(text, type = "success") {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, text, type }]);
  }

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  // ── on mount: load docs + past conversations, and reopen the last thread ──────
  useEffect(() => {
    fetchDocs();
    fetchConversations();
    // Restore the conversation the user last had open (survives navigation).
    const saved = localStorage.getItem(ACTIVE_CONVO_KEY);
    if (saved) loadConversation(saved, { silent: true });
    // Cancel any pending background-index poll timers on unmount.
    return () => pollTimersRef.current.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Show the scope banner for 8s whenever the active scope changes, then hide
  // it (the scope stays in force — the banner is just the announcement).
  const activeScopeKey = (selectedDocIds.length > 0 ? selectedDocIds : conversationDocIds).join(",");
  useEffect(() => {
    if (!activeScopeKey) {
      setBannerVisible(false);
      return;
    }
    setBannerVisible(true);
    const t = setTimeout(() => setBannerVisible(false), 8000);
    return () => clearTimeout(t);
  }, [activeScopeKey]);

  // History drawer filter — match on the thread title.
  const historyQ = historyQuery.trim().toLowerCase();
  const shownConversations = historyQ
    ? conversations.filter((c) => (c.title || "Untitled").toLowerCase().includes(historyQ))
    : conversations;

  // Documents the user can access (uploaded/processed), from Supabase.
  async function fetchDocs() {
    try {
      const res = await fetch(`${API_BASE}/api/documents`, {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      setDocList(data.documents || []); // [{ id, file_name, status, ... }]
    } catch {
      // silently ignore — backend may not be up yet
    }
  }

  // ── persisted conversations (Phase 3) ─────────────────────────────────────────
  async function fetchConversations() {
    try {
      const res = await fetch(`${API_BASE}/api/conversations`, {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      setConversations(data.conversations || []); // [{ id, title, created_at }]
    } catch {
      // silently ignore — backend may not be up yet
    }
  }

  // Load a past thread's messages (with their saved sources/charts/documents).
  // `silent` is used by the on-mount restore so a since-deleted thread doesn't
  // pop an error toast — it just clears the stale pointer and shows a fresh chat.
  async function loadConversation(id, { silent = false } = {}) {
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${id}`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || "Could not load the conversation");
      }
      const data = await res.json();
      const mapped = (data.messages || [])
        .filter((m) => m.sender_type !== "SYSTEM")
        .map((m) =>
          m.sender_type === "USER"
            ? { role: "user", text: m.content }
            : {
                id: m.id,
                role: "assistant",
                text: m.content,
                sources: m.metadata?.sources || [],
                citations: m.metadata?.citations || [],
                chart: m.metadata?.chart || undefined,
                document: m.metadata?.document || undefined,
                metric: m.metadata?.metric || undefined,
              }
        );
      setMessages([GREETING, ...mapped]);
      setConversationId(id);
      setConversationDocIds(data.conversation?.document_ids || []);
      localStorage.setItem(ACTIVE_CONVO_KEY, id);
      setShowHistory(false);
    } catch (err) {
      localStorage.removeItem(ACTIVE_CONVO_KEY); // drop a stale/deleted pointer
      if (!silent) notify(err.message, "error");
    }
  }

  async function deleteConversation(id) {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || "Delete failed");
      }
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (conversationId === id) newChat();
      notify("Conversation deleted.");
    } catch (err) {
      notify(err.message, "error");
    }
  }

  function newChat() {
    setConversationId(null);
    setConversationDocIds([]);
    setMessages([GREETING]);
    setShowHistory(false);
    localStorage.removeItem(ACTIVE_CONVO_KEY);
  }

  // ── remove ONE document everywhere (vector store + DB + Supabase + dashboard) ──
  async function removeDocument(d) {
    if (
      !window.confirm(
        `Remove "${d.file_name}" from the AI, database, and dashboard? This cannot be undone.`
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/documents/${d.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || "Remove failed");
      }
      setDocList((prev) => prev.filter((x) => x.id !== d.id));
      setSelectedDocIds((prev) => prev.filter((id) => id !== d.id));
      setConversationDocIds((prev) => prev.filter((id) => id !== d.id));
      notify(`Removed "${d.file_name}" from the AI, database, and dashboard.`);
    } catch (err) {
      notify(err.message, "error");
    }
  }

  // ── send chat message ──────────────────────────────────────────────────────
  // Two-phase send: first ask the backend which documents the question matches
  // (a vector search, no LLM). The picker is shown ONLY when the match is
  // ambiguous (several documents with similar scores) — when one document
  // clearly wins the answer is scoped to it automatically, saving a click.
  // Skipped entirely when the user already picked docs in the drawer, when
  // nothing matches (plain chat), or when the preview fails (best-effort).
  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");

    if (selectedDocIds.length > 0 || docList.length === 0) {
      await askAI(text, selectedDocIds.length > 0 ? selectedDocIds : undefined);
      return;
    }

    // Charts / tables / reports routinely combine data spread across several
    // files. The preview step below narrows to the single best-matching
    // document, which would drop the others and lose whole periods — so for
    // these requests skip narrowing and use everything the user can access.
    if (wantsAggregate(text)) {
      await askAI(text, undefined);
      return;
    }

    // Follow-up in a thread that already has an established document scope:
    // keep talking about the same docs instead of re-guessing per message.
    // Without this, "compare it to Q3" could silently re-match a different
    // document mid-conversation. Aggregate requests were already sent broad
    // above; manual drawer picks (the first guard) always win over this.
    if (conversationId && conversationDocIds.length > 0) {
      await askAI(text, conversationDocIds);
      return;
    }

    setLoading(true);
    let docs = [];
    let ambiguous = false;
    let previewOk = false;
    try {
      const res = await fetch(`${API_BASE}/api/rag/chat/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ message: text }),
      });
      if (res.ok) {
        const data = await res.json();
        docs = data.documents || [];
        ambiguous = !!data.ambiguous;
        previewOk = true;
      }
    } catch {
      /* preview unavailable — fall through and answer normally */
    }

    // Keep `loading` on through the hand-off to askAI. Clearing it here — between
    // the preview and the answer — would blink the typing dots off for a frame,
    // making it look like the assistant stopped. askAI owns `loading` from here
    // (it's already true), so the dots stay visible straight through to the answer.
    // Nothing matched, or preview failed → answer over everything the user can see.
    if (!previewOk || docs.length === 0) {
      await askAI(text, undefined);
      return;
    }
    // One clear winner (or a single match) → answer scoped to it, no picker.
    if (!ambiguous) {
      await askAI(text, docs.map((d) => d.id));
      return;
    }
    // Several close matches → stop the spinner and let the user disambiguate.
    setLoading(false);
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        picker: {
          question: text,
          docs,
          checked: docs.map((d) => d.id),
          status: "open", // open → done | cancelled
        },
      },
    ]);
  }

  // Ask the AI for the actual answer, searching only `documentIds` (undefined =
  // everything the user can access).
  async function askAI(text, documentIds) {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/rag/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          message: text,
          conversation_id: conversationId || undefined,
          document_ids: documentIds,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Something went wrong");
      }

      const data = await res.json();
      // First turn of a new thread — remember it and add it to the history list.
      if (data.conversation_id && data.conversation_id !== conversationId) {
        setConversationId(data.conversation_id);
        setConversations((prev) => [
          {
            id: data.conversation_id,
            title: data.conversation_title || text.slice(0, 80),
            created_at: new Date().toISOString(),
          },
          ...prev,
        ]);
      }
      // Remember the open thread so navigating away and back reopens it.
      if (data.conversation_id) {
        localStorage.setItem(ACTIVE_CONVO_KEY, data.conversation_id);
      }
      // A scoped answer anchors the thread to its documents (the backend
      // persists the same set on ai_conversations) — follow-ups reuse it.
      if (documentIds?.length && conversationDocIds.length === 0) {
        setConversationDocIds(documentIds);
      }
      setMessages((prev) => [
        ...prev,
        {
          id: data.message_id, // DB ai_messages.id — lets a pinned chart link back
          role: "assistant",
          text: data.answer,
          sources: data.sources || [],
          citations: data.retrieved || [], // provenance: source + page + char span
          doc_count: data.doc_count,
          chart: data.chart || undefined, // present when the prompt asked for a chart
          document: data.document || undefined, // present when a report was generated
          metric: data.metric || undefined, // present when the prompt asked to track a metric
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `❌ ${err.message}`, error: true },
      ]);
    } finally {
      setLoading(false);
    }
  }

  // ── document picker (confirm which docs the answer may use) ──────────────────
  function setPickerChecked(index, docId, on) {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === index && m.picker
          ? {
              ...m,
              picker: {
                ...m.picker,
                checked: on
                  ? [...m.picker.checked, docId]
                  : m.picker.checked.filter((id) => id !== docId),
              },
            }
          : m
      )
    );
  }

  function closePicker(index, status) {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === index && m.picker ? { ...m, picker: { ...m.picker, status } } : m
      )
    );
  }

  async function confirmPicker(index) {
    const p = messages[index]?.picker;
    if (!p || p.status !== "open" || p.checked.length === 0) return;
    closePicker(index, "done");
    await askAI(p.question, p.checked);
  }

  // ── upload one file ──────────────────────────────────────────────────────────
  async function uploadOne(file, overwrite = false) {
    const form = new FormData();
    form.append("file", file);
    if (overwrite) form.append("overwrite", "true");
    const res = await fetch(`${API_BASE}/api/rag/upload`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.message || "Upload failed");
      err.code = body.code; // "DUPLICATE_FILENAME" when the name is taken
      err.canOverwrite = body.can_overwrite;
      throw err;
    }
    return res.json();
  }

  // "report.pdf" → "report (1).pdf" — starting suggestion for the rename prompt.
  function suggestRename(name) {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    return `${base} (1)${ext}`;
  }

  // Upload one file; when a document with the same name already exists, ask the
  // user to update the existing document or rename the new file (re-checked, so
  // a rename that collides again just asks again).
  async function uploadResolvingDuplicates(file) {
    try {
      return await uploadOne(file);
    } catch (err) {
      if (err.code !== "DUPLICATE_FILENAME") throw err;

      if (err.canOverwrite) {
        const update = window.confirm(
          `A document named "${file.name}" already exists.\n\n` +
            "OK — update the existing document with this file (charts built from it can be refreshed).\n" +
            "Cancel — keep both by renaming the new file."
        );
        if (update) return uploadOne(file, true);
      } else {
        window.alert(
          `"${file.name}" was already uploaded by someone else in your organization — give your file a different name.`
        );
      }

      const newName = window.prompt(
        `New name for "${file.name}":`,
        suggestRename(file.name)
      );
      if (!newName || !newName.trim() || newName.trim() === file.name) {
        throw new Error("upload cancelled", { cause: err });
      }
      const renamed = new File([file], newName.trim(), { type: file.type });
      return uploadResolvingDuplicates(renamed);
    }
  }

  // ── upload one or more documents ─────────────────────────────────────────────
  // The backend accepts a single file per request, so we upload sequentially —
  // this also avoids overloading the RAG service's per-document LLM extraction.
  async function handleUpload(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setUploading(true);
    setUploadProgress({ done: 0, total: files.length });

    const succeeded = [];
    const failed = [];
    for (const file of files) {
      try {
        const data = await uploadResolvingDuplicates(file);
        succeeded.push({
          filename: data.filename,
          chunks: data.chunks,
          // Indexing now runs in the background on the RAG service; the doc
          // shows as "processing" in the sidebar until it flips to ready.
          processing: data.status === "processing",
          documentId: data.document_id,
        });
      } catch (err) {
        if (err.message !== "upload cancelled") {
          failed.push({ filename: file.name, error: err.message });
        }
      } finally {
        setUploadProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    }

    // Select the new doc only when a single one was uploaded;
    // multi-uploads keep the chat searching across everything.
    if (succeeded.length === 1 && failed.length === 0 && succeeded[0].documentId) {
      setSelectedDocIds([succeeded[0].documentId]);
    }

    if (succeeded.length === 1 && failed.length === 0) {
      notify(
        succeeded[0].processing
          ? `Uploaded "${succeeded[0].filename}" — indexing in the background; it'll be ready to query in a moment.`
          : `Indexed "${succeeded[0].filename}" (${succeeded[0].chunks} chunks) — selected for this chat.`
      );
    } else if (succeeded.length > 0) {
      notify(
        `Uploaded ${succeeded.length} documents (indexing in the background):\n${succeeded
          .map((s) => s.filename)
          .join(", ")}`
      );
    }
    if (failed.length > 0) {
      notify(
        `${failed.length} upload${failed.length > 1 ? "s" : ""} failed:\n${failed
          .map((f) => `${f.filename} — ${f.error}`)
          .join("\n")}`,
        "error"
      );
    }

    fetchDocs();
    // Background indexing: refresh again so "processing" flips to ready without a
    // manual reload. Cancel any prior batch first, and track the timers so the
    // unmount effect can clear them (no fetches fire after navigating away).
    pollTimersRef.current.forEach(clearTimeout);
    if (succeeded.some((s) => s.processing)) {
      pollTimersRef.current = [5000, 15000, 45000].map((ms) => setTimeout(fetchDocs, ms));
    } else {
      pollTimersRef.current = [];
    }
    setUploading(false);
    setUploadProgress(null);
    e.target.value = "";
  }

  // ── clear ALL documents (vector store + files + dashboard metrics) ────────────
  async function clearAllDocuments() {
    if (
      !window.confirm(
        "Remove ALL uploaded documents from the AI and reset the dashboard metrics? This cannot be undone."
      )
    ) {
      return;
    }
    setClearing(true);
    try {
      const res = await fetch(`${API_BASE}/api/rag/documents`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Clear failed");
      }
      setDocList([]);
      setSelectedDocIds([]);
      setShowDocs(false);
      notify("Cleared all documents and reset the dashboard metrics.");
    } catch (err) {
      notify(err.message, "error");
    } finally {
      setClearing(false);
    }
  }

  // ── pin a chart or metric to a dashboard ─────────────────────────────────────
  // The board list is the same for both: the user's personal dashboards, any
  // DEPARTMENT board they can edit (managers/admins), and the ORGANIZATION board
  // if they can edit it (admins).
  async function loadPinTargets() {
    let personal = [];
    let department = [];
    let organization = null;
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/dashboards`, {
        headers: authHeaders(),
      });
      if (res.ok) personal = (await res.json()).dashboards || [];
    } catch {
      // fall through — pin to the server-side default dashboard
    }
    if (authService.canManageDepartmentDashboards()) {
      try {
        const res = await fetch(`${API_BASE}/api/dashboard/department`, {
          headers: authHeaders(),
        });
        if (res.ok) {
          department = ((await res.json()).dashboards || []).filter((b) => b.can_edit);
        }
      } catch {
        // department boards unavailable — just offer personal ones
      }
    }
    if (authService.canManageOrganizationDashboard()) {
      try {
        const res = await fetch(`${API_BASE}/api/dashboard/organization`, {
          headers: authHeaders(),
        });
        if (res.ok) {
          const board = (await res.json()).dashboard;
          if (board && board.can_edit) organization = board;
        }
      } catch {
        // org board unavailable — just offer the others
      }
    }
    return [
      ...personal.map((d) => ({ kind: "personal", id: d.id, name: d.name })),
      ...department.map((b) => ({
        kind: "department",
        id: b.id,
        name: b.department_name,
        badge: "department",
      })),
      ...(organization
        ? [{ kind: "organization", id: organization.id, name: organization.name, badge: "organization" }]
        : []),
    ];
  }

  // Clicking "Pin"/"Add to dashboard" asks WHICH board when there's more than one;
  // with a single target there's nothing to choose, so we place it straight away.
  async function pinChart(spec, aiMessageId) {
    const targets = await loadPinTargets();
    if (targets.length > 1) {
      setPinPicker({ kind: "chart", payload: spec, title: spec.title || "This chart", aiMessageId, targets });
      return;
    }
    await pinToTarget("chart", spec, aiMessageId, targets[0] || null);
  }

  async function pinMetric(metric, aiMessageId) {
    const targets = await loadPinTargets();
    if (targets.length > 1) {
      setPinPicker({ kind: "metric", payload: metric, title: metric.label, aiMessageId, targets });
      return;
    }
    await pinToTarget("metric", metric, aiMessageId, targets[0] || null);
  }

  // Place a chart or a metric on `target` (null → the user's default personal
  // board). For charts, aiMessageId links the widget back to the message that
  // produced it so the dashboard can regenerate it on re-upload.
  async function pinToTarget(kind, payload, aiMessageId, target) {
    setPinningTo(target ? target.id : "default");
    try {
      const targetKind = target ? target.kind : "personal";
      const isDept = targetKind === "department";
      const isOrg = targetKind === "organization";
      const scopeLabel = isDept ? " (department)" : isOrg ? " (organization)" : "";
      const where = target ? `"${target.name}"${scopeLabel}` : "your dashboard";

      if (kind === "metric") {
        const res = await fetch(`${API_BASE}/api/dashboard/track-metric`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            label: payload.label,
            kind: payload.kind,
            metric_key: payload.metric_key,
            target: targetKind,
            board_id: target ? target.id : null,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || "Could not add the metric");
        }
        const already = res.status === 200; // 200 = already on that board
        notify(
          already
            ? `"${payload.label}" is already on ${where} — no duplicate added.`
            : `Added "${payload.label}" to ${where} — it will fill in as your documents are read.`
        );
        setPinPicker(null);
        return;
      }

      const spec = payload;
      const url = isDept
        ? `${API_BASE}/api/dashboard/department/${target.id}/widgets`
        : isOrg
          ? `${API_BASE}/api/dashboard/organization/widgets`
          : `${API_BASE}/api/dashboard/widgets`;
      const body = {
        widget_type: "ai_chart",
        title: spec.title || null,
        config: { spec },
        ai_message_id: aiMessageId || null,
      };
      if (!isDept && !isOrg) body.dashboard_id = target ? target.id : null; // personal board id
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Could not pin chart");
      }
      // 200 = it was already pinned there (idempotent); 201 = newly added.
      const alreadyPinned = res.status === 200;
      notify(
        alreadyPinned
          ? `That chart is already on ${where} — no duplicate added.`
          : `Added that chart to ${where}.`
      );
      setPinPicker(null);
    } catch (err) {
      notify(err.message, "error");
    } finally {
      setPinningTo(null);
    }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // ── download a cited source document ────────────────────────────────────────
  // Fetch a source's bytes. arrayBuffer + Blob (not response.blob()) — Chrome's
  // blob registry flakily rejects larger cross-origin responses (see
  // documentService.downloadBlob for the full story).
  async function fetchSourceBlob(filename) {
    const res = await fetch(
      `${API_BASE}/api/rag/download/${encodeURIComponent(filename)}`,
      { headers: authHeaders() }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Download failed");
    }
    const buf = await res.arrayBuffer();
    return new Blob([buf], {
      type: res.headers.get("content-type") || "application/octet-stream",
    });
  }

  // Preview a cited source in a modal — same pdf/text/csv rendering as the
  // Documents page (shared classes from Documents.css; helpers from utils).
  async function openCitePreview(filename) {
    setCiteViewer({ name: filename, loading: true });
    try {
      const blob = await fetchSourceBlob(filename);
      const kind = previewKind(filename);
      const typed = kind === "pdf" ? new Blob([blob], { type: "application/pdf" }) : blob;
      const url = URL.createObjectURL(typed);
      const next = { name: filename, loading: false, url, kind };
      if (kind === "text") next.text = await blob.text();
      if (kind === "csv") next.rows = parseCsv(await blob.text());
      setCiteViewer((v) => {
        if (!v || v.name !== filename) {
          URL.revokeObjectURL(url); // closed (or switched) while loading
          return v;
        }
        return next;
      });
    } catch (err) {
      setCiteViewer((v) =>
        v && v.name === filename ? { name: filename, loading: false, error: err.message } : v
      );
    }
  }

  function closeCitePreview() {
    setCiteViewer((v) => {
      if (v?.url) URL.revokeObjectURL(v.url);
      return null;
    });
  }

  async function downloadSource(filename) {
    try {
      const blob = await fetchSourceBlob(filename);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify(`Could not download "${filename}": ${err.message}`, "error");
    }
  }

  // ── re-index a generated document into the AI's knowledge base ───────────────
  async function ingestDocument(filename) {
    try {
      const res = await fetch(`${API_BASE}/api/rag/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ filename }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Could not add the document");
      }
      const data = await res.json();
      await fetchDocs();
      if (data.document_id) setSelectedDocIds([data.document_id]); // chat with the new report
      notify(
        `Added "${filename}" to the knowledge base (${data.chunks} chunks) — selected for this chat.`
      );
    } catch (err) {
      notify(err.message, "error");
    }
  }

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <AppShell className="ai-page">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <div className="ai-content">
        {/* Header */}
        <div className="ai-header">
          <div className="ai-header-title">
            <div>
              <h1>AI Assistant</h1>
              <p>
                {docList.length > 0
                  ? `${docList.length} document${docList.length > 1 ? "s" : ""} uploaded`
                  : "No documents uploaded yet — upload one below"}
              </p>
            </div>
          </div>

          <div className="ai-header-actions">
            <button
              className="docs-toggle-btn"
              onClick={newChat}
              title="Start a new conversation"
            >
              ＋ New chat
            </button>
            <button
              className="docs-toggle-btn"
              onClick={() => {
                setShowDocs(false);
                setShowHistory((v) => !v);
              }}
              title="Past conversations"
            >
              {showHistory ? "Hide history" : "History"}
            </button>
            {docList.length > 0 && (
              <button
                className="docs-toggle-btn"
                onClick={() => {
                  setShowHistory(false);
                  setShowDocs((v) => !v);
                }}
              >
                {showDocs ? "Hide docs" : "Show docs"}
              </button>
            )}
            {docList.length > 0 && (
              <button
                className="clear-docs-btn"
                onClick={clearAllDocuments}
                disabled={clearing || uploading}
                title="Remove all documents and reset dashboard metrics"
              >
                {clearing ? "Clearing…" : "🗑 Clear all"}
              </button>
            )}
            <button
              className="upload-doc-btn"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading
                ? uploadProgress
                  ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
                  : "Uploading…"
                : "＋ Upload docs"}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.csv,.txt,.xlsx,.xls,.docx,.pptx"
              style={{ display: "none" }}
              onChange={handleUpload}
            />
          </div>
        </div>

        {/* Scope banner — confirms which docs answers will use. Manual drawer
            picks win; otherwise the thread's established conversation scope.
            Auto-hides after 8s (countdown line below); ✕ dismisses early. */}
        {bannerVisible && (selectedDocIds.length > 0 || conversationDocIds.length > 0) && (
          <div className="focus-banner" key={activeScopeKey}>
            <span>
              🎯 {selectedDocIds.length > 0 ? "Answering from" : "Conversation about"}{" "}
              <strong>
                {(() => {
                  const ids = selectedDocIds.length > 0 ? selectedDocIds : conversationDocIds;
                  return (
                    docList
                      .filter((d) => ids.includes(d.id))
                      .map((d) => d.file_name)
                      .join(", ") || `${ids.length} document(s)`
                  );
                })()}
              </strong>
            </span>
            {selectedDocIds.length === 0 && (
              <button
                type="button"
                className="focus-clear"
                onClick={() => setShowDocs(true)}
                title="Pick different documents for this conversation"
              >
                Change
              </button>
            )}
            <button
              type="button"
              className="focus-clear"
              onClick={() => {
                setSelectedDocIds([]);
                setConversationDocIds([]);
              }}
              title="Clear scope (search all documents)"
            >
              Clear
            </button>
            <button
              type="button"
              className="focus-clear"
              onClick={() => setBannerVisible(false)}
              title="Dismiss (the scope stays active)"
              aria-label="Dismiss"
            >
              ✕
            </button>
            <div className="focus-banner-timer" aria-hidden="true" />
          </div>
        )}

        {/* Messages */}
        <div className="chat-messages">
          {messages.map((msg, i) => (
            <div key={msg.id ?? `m-${i}`} className={`chat-bubble ${msg.role} ${msg.error ? "error" : ""}`}>
              {msg.picker ? (
                <div className="doc-picker">
                  <div className="doc-picker-title">
                    {msg.picker.status === "cancelled"
                      ? "Okay, I won't answer that one."
                      : msg.picker.status === "done"
                        ? "Answering from these documents:"
                        : "I'd answer this from the documents below — untick any you don't want me to use:"}
                  </div>
                  {msg.picker.status !== "cancelled" && (
                    <div className="doc-picker-list">
                      {msg.picker.docs
                        .filter(
                          (d) =>
                            msg.picker.status === "open" ||
                            msg.picker.checked.includes(d.id)
                        )
                        .map((d) => (
                          <label key={d.id} className="doc-picker-item">
                            <input
                              type="checkbox"
                              disabled={msg.picker.status !== "open"}
                              checked={msg.picker.checked.includes(d.id)}
                              onChange={(e) => setPickerChecked(i, d.id, e.target.checked)}
                            />
                            <span className="doc-picker-name">📄 {d.file_name}</span>
                          </label>
                        ))}
                    </div>
                  )}
                  {msg.picker.status === "open" && (
                    <div className="doc-picker-actions">
                      <button
                        type="button"
                        className="doc-picker-answer"
                        onClick={() => confirmPicker(i)}
                        disabled={loading || msg.picker.checked.length === 0}
                      >
                        Answer with {msg.picker.checked.length} selected
                      </button>
                      <button
                        type="button"
                        className="doc-picker-cancel"
                        onClick={() => closePicker(i, "cancelled")}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              ) : msg.role === "assistant" && !msg.error ? (
                <div className="bubble-text markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      // eslint-disable-next-line no-unused-vars
                      a: ({ node, ...props }) => (
                        <a {...props} target="_blank" rel="noopener noreferrer" />
                      ),
                    }}
                  >
                    {msg.text}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="bubble-text">{msg.text}</div>
              )}
              {msg.chart && <ChartBlock spec={msg.chart} onPin={() => pinChart(msg.chart, msg.id)} />}
              {msg.metric && (
                <div className="doc-card">
                  <div className="doc-card-info">
                    <span className="doc-card-icon">📊</span>
                    <span className="doc-card-title">
                      {msg.metric.label}
                      <span className="metric-kind-tag"> · {msg.metric.kind}</span>
                    </span>
                  </div>
                  <div className="doc-card-actions">
                    <button
                      type="button"
                      onClick={() => pinMetric(msg.metric, msg.id)}
                      title="Track this metric as a KPI card on a dashboard"
                    >
                      📊 Add to dashboard
                    </button>
                  </div>
                </div>
              )}
              {msg.document && (
                <div className="doc-card">
                  <div className="doc-card-info">
                    <span className="doc-card-icon">📄</span>
                    <span className="doc-card-title">{msg.document.title}</span>
                  </div>
                  <div className="doc-card-actions">
                    <button
                      type="button"
                      onClick={() => downloadSource(msg.document.filename)}
                      title="Download the generated PDF"
                    >
                      ⬇ Download PDF
                    </button>
                    <button
                      type="button"
                      onClick={() => ingestDocument(msg.document.filename)}
                      title="Add this document to the AI's knowledge base"
                    >
                      ＋ Add to AI
                    </button>
                  </div>
                </div>
              )}
              {(msg.citations?.length > 0 || msg.sources?.length > 0) && (
                <div className="bubble-sources">
                  <button
                    type="button"
                    className="source-chip sources-open"
                    onClick={() =>
                      setSourcesPanel({
                        citations: dedupeCitations(msg.citations || []),
                        sources: msg.sources || [],
                      })
                    }
                    title="Show the sources this answer was grounded on"
                  >
                    Sources (
                    {msg.citations?.length > 0
                      ? dedupeCitations(msg.citations).length
                      : msg.sources.length}
                    )
                  </button>
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="chat-bubble assistant">
              <div className="typing-dots">
                <span /><span /><span />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="chat-input-container">
          <div className="chat-input">
            <textarea
              rows={1}
              placeholder={
                selectedDocIds.length > 0
                  ? `Ask about the selected document${selectedDocIds.length > 1 ? "s" : ""}, request a chart, or "generate a report"…`
                  : "Ask anything — request a chart or \"generate a report\" to get a PDF…"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              disabled={loading}
            />
            <button onClick={sendMessage} disabled={loading || !input.trim()}>
              {loading ? "…" : "Send"}
            </button>
          </div>
        </div>
      </div>

      {/* Documents drawer — newest uploaded first; click a doc to select it */}
      <div
        className={`docs-overlay ${showDocs || showHistory ? "open" : ""}`}
        onClick={() => {
          setShowDocs(false);
          setShowHistory(false);
        }}
      />
      <aside className={`docs-drawer ${showDocs ? "open" : ""}`} aria-hidden={!showDocs}>
        <div className="docs-drawer-header">
          <div>
            <h2>Documents</h2>
            <span className="docs-drawer-hint">
              {docList.length} uploaded · click to select for the chat · 🗑 to remove everywhere
            </span>
          </div>
          <button
            className="docs-drawer-close"
            onClick={() => setShowDocs(false)}
            aria-label="Close documents"
          >
            ✕
          </button>
        </div>

        {docList.length === 0 ? (
          <div className="docs-empty">No documents uploaded yet.</div>
        ) : (
          <div className="docs-drawer-list">
            {docList.map((d) => (
              <div key={d.id} className="docs-drawer-row">
                <button
                  type="button"
                  className={`docs-drawer-item ${selectedDocIds.includes(d.id) ? "active" : ""}`}
                  onClick={() =>
                    setSelectedDocIds((prev) =>
                      prev.includes(d.id)
                        ? prev.filter((id) => id !== d.id)
                        : [...prev, d.id]
                    )
                  }
                  title={
                    selectedDocIds.includes(d.id)
                      ? "Click to deselect"
                      : `Use ${d.file_name} for the chat`
                  }
                >
                  <span className="docs-item-name">📄 {d.file_name}</span>
                  <span className={`docs-item-status ${(d.status || "").toLowerCase()}`}>
                    {d.status === "PROCESSED" ? "ready" : (d.status || "").toLowerCase()}
                  </span>
                  {selectedDocIds.includes(d.id) && (
                    <span className="docs-item-focus">selected</span>
                  )}
                </button>
                <button
                  type="button"
                  className="docs-item-remove"
                  onClick={() => removeDocument(d)}
                  title="Remove from AI, database, and dashboard"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Chat-history drawer — persisted conversations; click one to resume it */}
      <aside className={`docs-drawer ${showHistory ? "open" : ""}`} aria-hidden={!showHistory}>
        <div className="docs-drawer-header">
          <div>
            <h2>Chat history</h2>
            <span className="docs-drawer-hint">
              {conversations.length} conversation{conversations.length === 1 ? "" : "s"} · click to
              resume · 🗑 to delete
            </span>
          </div>
          <button
            className="docs-drawer-close"
            onClick={() => setShowHistory(false)}
            aria-label="Close chat history"
          >
            ✕
          </button>
        </div>

        {conversations.length > 0 && (
          <input
            type="search"
            className="drawer-search"
            placeholder="Search conversations…"
            value={historyQuery}
            onChange={(e) => setHistoryQuery(e.target.value)}
            aria-label="Search conversations"
          />
        )}

        {conversations.length === 0 ? (
          <div className="docs-empty">No conversations yet — say hi!</div>
        ) : shownConversations.length === 0 ? (
          <div className="docs-empty">No conversations match "{historyQuery}".</div>
        ) : (
          <div className="docs-drawer-list">
            {shownConversations.map((c) => (
              <div key={c.id} className="docs-drawer-row">
                <button
                  type="button"
                  className={`docs-drawer-item ${conversationId === c.id ? "active" : ""}`}
                  onClick={() => loadConversation(c.id)}
                  title={`Resume "${c.title || "Untitled"}"`}
                >
                  <span className="docs-item-name">💬 {c.title || "Untitled"}</span>
                  <span className="convs-item-date">
                    {c.created_at ? new Date(c.created_at).toLocaleDateString() : ""}
                  </span>
                  {conversationId === c.id && (
                    <span className="docs-item-focus">current</span>
                  )}
                </button>
                <button
                  type="button"
                  className="docs-item-remove"
                  onClick={() => deleteConversation(c.id)}
                  title="Delete this conversation"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Sources panel — the citations behind one answer, previewable and
          downloadable like the Documents page. */}
      <aside className={`docs-drawer ${sourcesPanel ? "open" : ""}`} aria-hidden={!sourcesPanel}>
        <div className="docs-drawer-header">
          <div>
            <h2>Sources</h2>
            <span className="docs-drawer-hint">
              What this answer was grounded on — click a source to preview it.
            </span>
          </div>
          <button
            className="docs-drawer-close"
            onClick={() => setSourcesPanel(null)}
            title="Close"
            aria-label="Close sources"
          >
            ✕
          </button>
        </div>
        {sourcesPanel && (
          <div className="docs-drawer-list">
            {sourcesPanel.citations.length > 0
              ? sourcesPanel.citations.map((c, i) => {
                  const name = c.file_name || "source";
                  const pct = c.similarity != null ? Math.round(c.similarity * 100) : null;
                  return (
                    <div key={`${name}-${c.page ?? ""}-${i}`} className="docs-drawer-row">
                      <button
                        type="button"
                        className="docs-drawer-item"
                        onClick={() => c.file_name && openCitePreview(c.file_name)}
                        title={`Preview ${name}`}
                      >
                        <span className="docs-item-name">📄 {name}</span>
                        <span className="convs-item-date">
                          {c.page != null ? `p.${c.page}` : ""}
                          {pct != null ? `${c.page != null ? " · " : ""}${pct}% match` : ""}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="docs-item-remove"
                        onClick={() => c.file_name && downloadSource(c.file_name)}
                        title={`Download ${name}`}
                      >
                        ⬇
                      </button>
                    </div>
                  );
                })
              : sourcesPanel.sources.map((s) => (
                  <div key={s} className="docs-drawer-row">
                    <button
                      type="button"
                      className="docs-drawer-item"
                      onClick={() => openCitePreview(s)}
                      title={`Preview ${s}`}
                    >
                      <span className="docs-item-name">📄 {s}</span>
                    </button>
                    <button
                      type="button"
                      className="docs-item-remove"
                      onClick={() => downloadSource(s)}
                      title={`Download ${s}`}
                    >
                      ⬇
                    </button>
                  </div>
                ))}
          </div>
        )}
      </aside>

      {/* Citation preview — pdf/text/csv modal, same classes as the Documents
          page viewer (Documents.css is in the global bundle). */}
      {citeViewer && (
        <>
          <div className="viewer-overlay" onClick={closeCitePreview} />
          <div className="viewer-modal" role="dialog" aria-label={`Preview of ${citeViewer.name}`}>
            <div className="viewer-header">
              <span className="viewer-title" title={citeViewer.name}>
                {citeViewer.name}
              </span>
              <div className="viewer-actions">
                <button
                  type="button"
                  className="viewer-btn"
                  onClick={() => downloadSource(citeViewer.name)}
                  title="Download"
                  aria-label="Download"
                >
                  ⬇
                </button>
                <button
                  type="button"
                  className="viewer-btn"
                  onClick={closeCitePreview}
                  title="Close"
                  aria-label="Close preview"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="viewer-body">
              {citeViewer.loading ? (
                <p className="viewer-msg">Loading…</p>
              ) : citeViewer.error ? (
                <p className="viewer-msg viewer-error">❌ {citeViewer.error}</p>
              ) : citeViewer.kind === "pdf" ? (
                <iframe className="viewer-frame" src={citeViewer.url} title={citeViewer.name} />
              ) : citeViewer.kind === "text" ? (
                <pre className="viewer-pre">{citeViewer.text}</pre>
              ) : citeViewer.kind === "csv" && citeViewer.rows?.length > 0 ? (
                <div className="viewer-table-wrap">
                  <table className="viewer-table">
                    <thead>
                      <tr>
                        {citeViewer.rows[0].map((h, i) => (
                          <th key={i}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {citeViewer.rows.slice(1).map((r, i) => (
                        <tr key={i}>
                          {r.map((c, j) => (
                            <td key={j}>{c}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="viewer-fallback">
                  <span className="viewer-fallback-icon">📄</span>
                  <p>No in-browser preview for this file type.</p>
                  <button
                    type="button"
                    className="viewer-download-btn"
                    onClick={() => downloadSource(citeViewer.name)}
                  >
                    ⬇ Download {citeViewer.name}
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Pin-to-dashboard picker — shown when the user has more than one dashboard */}
      {pinPicker && (
        <>
          <div
            className="pin-overlay"
            onClick={() => pinningTo === null && setPinPicker(null)}
          />
          <div className="pin-modal" role="dialog" aria-label="Choose a dashboard">
            <div className="pin-modal-title">
              {pinPicker.kind === "metric" ? "Track this metric on which dashboard?" : "Pin to which dashboard?"}
            </div>
            <div className="pin-modal-hint">
              {pinPicker.title} will appear as a{" "}
              {pinPicker.kind === "metric" ? "KPI card" : "widget"} there.
            </div>
            <div className="pin-modal-list">
              {pinPicker.targets.map((t) => (
                <button
                  key={`${t.kind}-${t.id}`}
                  type="button"
                  className="pin-modal-option"
                  disabled={pinningTo !== null}
                  onClick={() => pinToTarget(pinPicker.kind, pinPicker.payload, pinPicker.aiMessageId, t)}
                >
                  <span className="pin-modal-name">{t.name}</span>
                  {t.badge && <span className="pin-modal-badge">{t.badge}</span>}
                  {pinningTo === t.id && <span className="pin-modal-busy">Adding…</span>}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="pin-modal-cancel"
              onClick={() => setPinPicker(null)}
              disabled={pinningTo !== null}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </AppShell>
  );
}

export default AIAssistant;
