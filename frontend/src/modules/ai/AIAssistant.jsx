import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Sidebar from "../../components/Sidebar";
import ChartBlock from "./ChartBlock";
import "./AIAssistant.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

const GREETING = {
  role: "assistant",
  text: "Hi! I'm SNAP AI. Upload documents and ask me anything — including \"show me a bar chart of sales by region\" to generate charts, or \"generate a report summarizing this document\" to create a downloadable PDF.",
};

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

  const bottomRef = useRef(null);
  const fileRef = useRef(null);

  // ── on mount: load docs + past conversations ─────────────────────────────────
  useEffect(() => {
    fetchDocs();
    fetchConversations();
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
  async function loadConversation(id) {
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
                chart: m.metadata?.chart || undefined,
                document: m.metadata?.document || undefined,
              }
        );
      setMessages([GREETING, ...mapped]);
      setConversationId(id);
      setShowHistory(false);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `❌ ${err.message}`, error: true },
      ]);
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
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `❌ ${err.message}`, error: true },
      ]);
    }
  }

  function newChat() {
    setConversationId(null);
    setMessages([GREETING]);
    setShowHistory(false);
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
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `🗑️ Removed **${d.file_name}** from the AI, vector store, database, and dashboard metrics.`,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `❌ ${err.message}`, error: true },
      ]);
    }
  }

  // ── send chat message ──────────────────────────────────────────────────────
  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/rag/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          message: text,
          conversation_id: conversationId || undefined,
          document_ids: selectedDocIds.length > 0 ? selectedDocIds : undefined,
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
      setMessages((prev) => [
        ...prev,
        {
          id: data.message_id, // DB ai_messages.id — lets a pinned chart link back
          role: "assistant",
          text: data.answer,
          sources: data.sources || [],
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

  // ── upload one file ──────────────────────────────────────────────────────────
  async function uploadOne(file) {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_BASE}/api/rag/upload`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Upload failed");
    }
    return res.json();
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
        const data = await uploadOne(file);
        succeeded.push({ filename: data.filename, chunks: data.chunks, documentId: data.document_id });
      } catch (err) {
        failed.push({ filename: file.name, error: err.message });
      } finally {
        setUploadProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    }

    // Select the new doc only when a single one was uploaded;
    // multi-uploads keep the chat searching across everything.
    if (succeeded.length === 1 && failed.length === 0 && succeeded[0].documentId) {
      setSelectedDocIds([succeeded[0].documentId]);
    }

    const lines = [];
    if (succeeded.length > 0) {
      lines.push(
        `✅ Indexed ${succeeded.length} document${succeeded.length > 1 ? "s" : ""}:`,
        ...succeeded.map((s) => `- **${s.filename}** — ${s.chunks} chunks`)
      );
    }
    if (failed.length > 0) {
      lines.push(
        `❌ ${failed.length} failed:`,
        ...failed.map((f) => `- **${f.filename}** — ${f.error}`)
      );
    }
    if (succeeded.length === 1 && failed.length === 0) {
      lines.push(
        "",
        'I\'ve selected this document for our chat. Try *"Give me a summary of this document"* or any question about it.'
      );
    }

    setMessages((prev) => [
      ...prev,
      { role: "assistant", text: lines.join("\n"), error: succeeded.length === 0 },
    ]);

    fetchDocs();
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
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "🗑️ Cleared all documents and reset the dashboard metrics. Upload new documents to start again.",
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `❌ ${err.message}`, error: true },
      ]);
    } finally {
      setClearing(false);
    }
  }

  // ── pin a generated chart/table to the dashboard ─────────────────────────────
  // aiMessageId links the pinned widget back to the message that produced it, so
  // the dashboard can regenerate the chart against fresh data on re-upload.
  async function pinChart(spec, aiMessageId) {
    try {
      // Pin to whichever dashboard the user last had open (persisted by the
      // Dashboard page). Omitted/unknown → the server falls back to the default.
      const activeDashboardId = localStorage.getItem("activeDashboardId") || null;
      const res = await fetch(`${API_BASE}/api/dashboard/widgets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          widget_type: "ai_chart",
          title: spec.title || null,
          config: { spec },
          ai_message_id: aiMessageId || null,
          dashboard_id: activeDashboardId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Could not pin chart");
      }
      // 200 = it was already pinned (idempotent); 201 = newly added.
      const alreadyPinned = res.status === 200;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: alreadyPinned
            ? "📌 That chart is already on your **Dashboard** — no duplicate added."
            : "📌 Added that chart to your dashboard — open the **Dashboard** to see it.",
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `❌ ${err.message}`, error: true },
      ]);
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
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `❌ Could not download "${filename}": ${err.message}`, error: true },
      ]);
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
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `✅ Added **${filename}** to my knowledge base (${data.chunks} chunks). I've selected it for our chat — ask me anything about it.`,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `❌ ${err.message}`, error: true },
      ]);
    }
  }

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="ai-layout">
      <Sidebar />

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
              {msg.role === "assistant" && !msg.error ? (
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
              {msg.sources?.length > 0 && (
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
    </div>
  );
}

export default AIAssistant;
