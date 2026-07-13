import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Sidebar from "../../components/Sidebar";
import ToastStack from "../../components/Toast";
import ChartBlock from "./ChartBlock";
import { authService } from "../../services/authService";
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
  // Persisted chat threads (Phase 3).
  const [conversationId, setConversationId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  // Transient popup notifications (auto-dismiss after a few seconds).
  const [toasts, setToasts] = useState([]);
  // "Pin to dashboard" picker: { spec, aiMessageId, dashboards } while choosing.
  const [pinPicker, setPinPicker] = useState(null);
  const [pinningTo, setPinningTo] = useState(null); // dashboard id being pinned to

  const bottomRef = useRef(null);
  const fileRef = useRef(null);
  const toastIdRef = useRef(0);

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
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
              }
        );
      setMessages([GREETING, ...mapped]);
      setConversationId(id);
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
    setLoading(false);

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
    // Several close matches → let the user disambiguate.
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
    // Background indexing: refresh again so "processing" flips to ready
    // without a manual reload once the RAG service finishes.
    if (succeeded.some((s) => s.processing)) {
      setTimeout(fetchDocs, 5000);
      setTimeout(fetchDocs, 15000);
      setTimeout(fetchDocs, 45000);
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

  // ── pin a generated chart/table to a dashboard ───────────────────────────────
  // Clicking "Pin" first asks WHICH board to pin to: the user's personal
  // dashboards plus any DEPARTMENT board they can edit (managers/admins). With a
  // single target there's nothing to choose, so we pin straight away.
  async function pinChart(spec, aiMessageId) {
    let personal = [];
    let department = [];
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
    const targets = [
      ...personal.map((d) => ({ kind: "personal", id: d.id, name: d.name })),
      ...department.map((b) => ({
        kind: "department",
        id: b.id,
        name: b.department_name,
        badge: "department",
      })),
    ];
    if (targets.length > 1) {
      setPinPicker({ spec, aiMessageId, targets });
      return;
    }
    await pinToTarget(spec, aiMessageId, targets[0] || null);
  }

  // aiMessageId links the pinned widget back to the message that produced it, so
  // the dashboard can regenerate the chart against fresh data on re-upload.
  // target = null → the server falls back to the user's default personal board.
  async function pinToTarget(spec, aiMessageId, target) {
    setPinningTo(target ? target.id : "default");
    try {
      const isDept = target && target.kind === "department";
      const url = isDept
        ? `${API_BASE}/api/dashboard/department/${target.id}/widgets`
        : `${API_BASE}/api/dashboard/widgets`;
      const body = {
        widget_type: "ai_chart",
        title: spec.title || null,
        config: { spec },
        ai_message_id: aiMessageId || null,
      };
      if (!isDept) body.dashboard_id = target ? target.id : null; // personal board id
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
      const where = target
        ? `"${target.name}"${isDept ? " (department)" : ""}`
        : "your dashboard";
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
  async function downloadSource(filename) {
    try {
      const res = await fetch(
        `${API_BASE}/api/rag/download/${encodeURIComponent(filename)}`,
        { headers: authHeaders() }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Download failed");
      }
      const blob = await res.blob();
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
    <div className="ai-layout">
      <Sidebar />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <main className="ai-content">
        {/* Header */}
        <div className="ai-header">
          <div className="ai-header-title">
            <div>
              <h1>SNAP AI Assistant</h1>
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

        {/* Selected-documents banner — confirms which docs answers will use */}
        {selectedDocIds.length > 0 && (
          <div className="focus-banner">
            <span>
              🎯 Answering from{" "}
              <strong>
                {docList
                  .filter((d) => selectedDocIds.includes(d.id))
                  .map((d) => d.file_name)
                  .join(", ") || `${selectedDocIds.length} selected document(s)`}
              </strong>
            </span>
            <button
              type="button"
              className="focus-clear"
              onClick={() => setSelectedDocIds([])}
              title="Clear selection (search all documents)"
            >
              ✕ Clear
            </button>
          </div>
        )}

        {/* Messages */}
        <div className="chat-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`chat-bubble ${msg.role} ${msg.error ? "error" : ""}`}>
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
              {msg.citations?.length > 0 ? (
                <div className="bubble-sources">
                  Cited from:{" "}
                  {dedupeCitations(msg.citations).map((c, i) => {
                    const name = c.file_name || "source";
                    const pct = c.similarity != null ? Math.round(c.similarity * 100) : null;
                    const span =
                      c.char_start != null && c.char_end != null
                        ? ` · chars ${c.char_start}–${c.char_end}`
                        : "";
                    return (
                      <button
                        key={`${name}-${c.page ?? ""}-${i}`}
                        type="button"
                        className="source-chip"
                        onClick={() => c.file_name && downloadSource(c.file_name)}
                        title={`${pct != null ? `Relevance ${pct}%` : ""}${span} — click to open the source`}
                      >
                        📄 {name}
                        {c.page != null ? ` · p.${c.page}` : ""}
                      </button>
                    );
                  })}
                </div>
              ) : (
                msg.sources?.length > 0 && (
                  <div className="bubble-sources">
                    Sources:{" "}
                    {msg.sources.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="source-chip"
                        onClick={() => downloadSource(s)}
                        title={`Download ${s}`}
                      >
                        ⬇ {s}
                      </button>
                    ))}
                  </div>
                )
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
      </main>

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

        {conversations.length === 0 ? (
          <div className="docs-empty">No conversations yet — say hi!</div>
        ) : (
          <div className="docs-drawer-list">
            {conversations.map((c) => (
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

      {/* Pin-to-dashboard picker — shown when the user has more than one dashboard */}
      {pinPicker && (
        <>
          <div
            className="pin-overlay"
            onClick={() => pinningTo === null && setPinPicker(null)}
          />
          <div className="pin-modal" role="dialog" aria-label="Choose a dashboard">
            <div className="pin-modal-title">Pin to which dashboard?</div>
            <div className="pin-modal-hint">
              {pinPicker.spec.title || "This chart"} will appear as a widget there.
            </div>
            <div className="pin-modal-list">
              {pinPicker.targets.map((t) => (
                <button
                  key={`${t.kind}-${t.id}`}
                  type="button"
                  className="pin-modal-option"
                  disabled={pinningTo !== null}
                  onClick={() => pinToTarget(pinPicker.spec, pinPicker.aiMessageId, t)}
                >
                  <span className="pin-modal-name">{t.name}</span>
                  {t.badge && <span className="pin-modal-badge">{t.badge}</span>}
                  {pinningTo === t.id && <span className="pin-modal-busy">Pinning…</span>}
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
    </div>
  );
}

export default AIAssistant;
