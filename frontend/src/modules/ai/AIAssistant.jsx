import { useEffect, useRef, useState } from "react";
import Sidebar from "../../components/Sidebar";
import "./AIAssistant.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

function getToken() {
  return localStorage.getItem("token");
}

function AIAssistant() {
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      text: "Hi! I'm SNAP AI. Upload documents and ask me anything about them.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [docCount, setDocCount] = useState(0);
  const [docList, setDocList] = useState([]);
  const [showDocs, setShowDocs] = useState(false);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);

  // ── fetch indexed documents on mount ──────────────────────────────────────
  useEffect(() => {
    fetchDocs();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function fetchDocs() {
    try {
      const res = await fetch(`${API_BASE}/api/rag/documents`, {
        headers: { Authorization: `Bearer ${getToken()}` },
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ message: text }),
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

  // ── upload document ────────────────────────────────────────────────────────
  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch(`${API_BASE}/api/rag/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }

      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `✅ Indexed **${data.filename}** — ${data.chunks_indexed} chunks added. Total chunks: ${data.total_docs}.`,
        },
      ]);
      fetchDocs();
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `❌ Upload error: ${err.message}`, error: true },
      ]);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="ai-layout">
      <Sidebar />

      <main className="ai-content">
        {/* Header */}
        <div className="ai-header">
          <div>
            <h1>SNAP AI Assistant</h1>
            <p>
              {docList.length > 0
                ? `${docList.length} document${docList.length > 1 ? "s" : ""} indexed (${docCount} chunks)`
                : "No documents indexed yet — upload one below"}
            </p>
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
            <button
              className="upload-doc-btn"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "Uploading…" : "＋ Upload doc"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.csv,.txt,.xlsx,.xls"
              style={{ display: "none" }}
              onChange={handleUpload}
            />
          </div>
        </div>

        {/* Indexed doc list */}
        {showDocs && docList.length > 0 && (
          <div className="doc-list">
            {docList.map((d) => (
              <span key={d} className="doc-chip">
                📄 {d}
              </span>
            ))}
          </div>
        )}

        {/* Messages */}
        <div className="chat-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`chat-bubble ${msg.role} ${msg.error ? "error" : ""}`}>
              <div className="bubble-text">{msg.text}</div>
              {msg.sources?.length > 0 && (
                <div className="bubble-sources">
                  Sources:{" "}
                  {msg.sources.map((s) => (
                    <span key={s} className="source-chip">
                      {s}
                    </span>
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
              placeholder="Ask anything about your documents…"
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
    </div>
  );
}

export default AIAssistant;
