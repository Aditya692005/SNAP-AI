import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AppShell from "../../components/AppShell";
import ToastStack from "../../components/Toast";
import "../documents/Documents.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem("token")}` };
}

// Reports the AI generated on request ("generate a report on …" in the
// assistant). The files are PDFs in Storage; this page lists, previews and
// downloads them. Generation itself stays in the AI Assistant.
function Reports() {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  // Preview modal: { report, loading, url?, error? } — reports are always PDFs.
  const [viewer, setViewer] = useState(null);
  const [toasts, setToasts] = useState([]);

  function notify(text, type = "success") {
    setToasts((prev) => [...prev, { id: Date.now() + Math.random(), text, type }]);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/conversations/reports`, {
          headers: authHeaders(),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.message || "Could not load reports");
        }
        const data = await res.json();
        if (!cancelled) setReports(data.reports || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch the PDF bytes for preview/download. arrayBuffer + Blob (not
  // response.blob()) — Chrome's blob registry flakily rejects larger
  // cross-origin responses (see documentService.downloadBlob).
  async function fetchReportBlob(filename) {
    const res = await fetch(
      `${API_BASE}/api/rag/download/${encodeURIComponent(filename)}`,
      { headers: authHeaders() }
    );
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.message || "Could not load the report");
    }
    const buf = await res.arrayBuffer();
    return new Blob([buf], { type: "application/pdf" });
  }

  async function openViewer(r) {
    setViewer({ report: r, loading: true });
    try {
      const blob = await fetchReportBlob(r.filename);
      const url = URL.createObjectURL(blob);
      setViewer((v) => {
        if (!v || v.report.id !== r.id) {
          URL.revokeObjectURL(url); // closed (or switched) while loading
          return v;
        }
        return { report: r, loading: false, url };
      });
    } catch (err) {
      setViewer((v) =>
        v && v.report.id === r.id ? { report: r, loading: false, error: err.message } : v
      );
    }
  }

  function closeViewer() {
    setViewer((v) => {
      if (v?.url) URL.revokeObjectURL(v.url);
      return null;
    });
  }

  async function downloadReport(r, existingUrl) {
    try {
      const url = existingUrl || URL.createObjectURL(await fetchReportBlob(r.filename));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (!existingUrl) URL.revokeObjectURL(url);
    } catch (err) {
      notify(`Could not download "${r.filename}": ${err.message}`, "error");
    }
  }

  const q = query.trim().toLowerCase();
  const shown = q
    ? reports.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.filename.toLowerCase().includes(q) ||
          (r.conversation_title || "").toLowerCase().includes(q)
      )
    : reports;

  return (
    <AppShell>
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />

      <div className="documents-content">
        <div className="documents-header">
          <h1>Reports</h1>
          <p>Reports the AI Assistant generated for you.</p>
        </div>

        <div className="documents-section">
          <div className="section-header">
            <h2>Your Reports</h2>
            <div className="section-header-actions">
              <input
                type="search"
                className="doc-search"
                placeholder="Search reports…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search reports"
              />
              <span>
                {loading ? "Loading…" : `${shown.length} report${shown.length === 1 ? "" : "s"}`}
              </span>
            </div>
          </div>

          <div className="documents-list">
            {error && (
              <div className="document-row">
                <div className="document-info">
                  <p>❌ {error}</p>
                </div>
              </div>
            )}

            {!loading && !error && reports.length === 0 && (
              <div className="document-row">
                <div className="document-info">
                  <h3>No reports yet</h3>
                  <p>
                    Ask the <Link to="/ai">AI Assistant</Link> to "generate a report on …" —
                    everything it produces shows up here.
                  </p>
                </div>
              </div>
            )}

            {!loading && !error && reports.length > 0 && shown.length === 0 && (
              <div className="document-row">
                <div className="document-info">
                  <p>No reports match "{query}".</p>
                </div>
              </div>
            )}

            {shown.map((r) => (
              <div key={r.id} className="document-row">
                <button
                  type="button"
                  className="document-info document-open"
                  onClick={() => openViewer(r)}
                  title={`Preview "${r.filename}"`}
                >
                  <h3>{r.title}</h3>
                  <p>
                    {r.filename}
                    {r.conversation_title ? ` · from "${r.conversation_title}"` : ""}
                    {r.created_at
                      ? ` · ${new Date(r.created_at).toLocaleDateString()}`
                      : ""}
                  </p>
                </button>
                <div className="document-actions">
                  <button
                    type="button"
                    className="share-button"
                    onClick={() => downloadReport(r)}
                    title="Download this report"
                  >
                    ⬇ Download
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* PDF preview — same modal pattern as the Documents page */}
      {viewer && (
        <>
          <div className="viewer-overlay" onClick={closeViewer} />
          <div
            className="viewer-modal"
            role="dialog"
            aria-label={`Preview of ${viewer.report.filename}`}
          >
            <div className="viewer-header">
              <span className="viewer-title" title={viewer.report.filename}>
                {viewer.report.title}
              </span>
              <div className="viewer-actions">
                <button
                  type="button"
                  className="viewer-btn"
                  onClick={() => downloadReport(viewer.report, viewer.url)}
                  disabled={!viewer.url}
                  title="Download"
                  aria-label="Download"
                >
                  ⬇
                </button>
                <button
                  type="button"
                  className="viewer-btn"
                  onClick={closeViewer}
                  title="Close"
                  aria-label="Close preview"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="viewer-body">
              {viewer.loading ? (
                <p className="viewer-msg">Loading…</p>
              ) : viewer.error ? (
                <p className="viewer-msg viewer-error">❌ {viewer.error}</p>
              ) : (
                <iframe
                  className="viewer-frame"
                  src={viewer.url}
                  title={viewer.report.filename}
                />
              )}
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}

export default Reports;
