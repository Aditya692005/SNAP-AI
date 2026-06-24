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
  const [docCount, setDocCount] = useState(0);
  const [docList, setDocList] = useState([]);
  const [showDocs, setShowDocs] = useState(false);
  const [activeDoc, setActiveDoc] = useState(null);

  const bottomRef = useRef(null);
  const fileRef = useRef(null);

  // ── on mount: load docs ──────────────────────────────────────────────────────
  useEffect(() => {
    fetchDocs();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function fetchDocs() {
    try {
      const res = await fetch(`${API_BASE}/api/rag/documents`, {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      setDocList(data.documents || []);
      setDocCount(data.total_chunks || 0);
    } catch {
      // silently ignore — RAG service may not be up yet
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
          source: activeDoc || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Something went wrong");
      }

      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        {
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
        succeeded.push({ filename: data.filename, chunks: data.chunks_indexed });
      } catch (err) {
        failed.push({ filename: file.name, error: err.message });
      } finally {
        setUploadProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    }

    // Focus the chat on the new doc only when a single one was uploaded;
    // multi-uploads keep the chat searching across everything.
    if (succeeded.length === 1 && failed.length === 0) {
      setActiveDoc(succeeded[0].filename);
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
        'I\'m now focused on this document. Try *"Give me a summary of this document"* or any question about it.'
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
      setDocCount(0);
      setActiveDoc(null);
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
  async function pinChart(spec) {
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/charts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ spec }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Could not pin chart");
      }
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "📌 Added that chart to your dashboard — open the **Dashboard** to see it under *Pinned charts*.",
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
      setActiveDoc(filename); // focus the chat on the newly added report
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `✅ Added **${filename}** to my knowledge base (${data.chunks_indexed} chunks). I'm now focused on it — ask me anything about it.`,
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
                  ? `${docList.length} document${docList.length > 1 ? "s" : ""} indexed (${docCount} chunks)`
                  : "No documents indexed yet — upload one below"}
              </p>
            </div>
          </div>

          <div className="ai-header-actions">
            {docList.length > 0 && (
              <button
                className="docs-toggle-btn"
                onClick={() => setShowDocs((v) => !v)}
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

        {/* Active document focus banner */}
        {activeDoc && (
          <div className="focus-banner">
            <span>
              🎯 Focused on <strong>{activeDoc}</strong> — answers will use this document.
            </span>
            <button
              type="button"
              className="focus-clear"
              onClick={() => setActiveDoc(null)}
              title="Clear focus (search all documents)"
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
              {msg.chart && <ChartBlock spec={msg.chart} onPin={pinChart} />}
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
                activeDoc
                  ? `Ask about ${activeDoc}, request a chart, or "generate a report on this"…`
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

      {/* Documents drawer — newest uploaded first; click a doc to focus the chat */}
      <div
        className={`docs-overlay ${showDocs ? "open" : ""}`}
        onClick={() => setShowDocs(false)}
      />
      <aside className={`docs-drawer ${showDocs ? "open" : ""}`} aria-hidden={!showDocs}>
        <div className="docs-drawer-header">
          <div>
            <h2>Documents</h2>
            <span className="docs-drawer-hint">
              {docList.length} indexed · newest first · click to focus the chat
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
              <button
                key={d}
                type="button"
                className={`docs-drawer-item ${activeDoc === d ? "active" : ""}`}
                onClick={() => setActiveDoc(activeDoc === d ? null : d)}
                title={activeDoc === d ? "Click to unfocus" : `Focus chat on ${d}`}
              >
                <span className="docs-item-name">📄 {d}</span>
                {activeDoc === d && <span className="docs-item-focus">focused</span>}
              </button>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

export default AIAssistant;
