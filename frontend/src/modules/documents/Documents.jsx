import { useEffect, useState } from "react";
import Sidebar from "../../components/Sidebar";
import "./Documents.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

function getToken() {
  return localStorage.getItem("token");
}

function authHeaders() {
  return { Authorization: `Bearer ${getToken()}` };
}

// Human-readable status + badge style for a document's processing state.
function statusLabel(status) {
  const s = (status || "").toUpperCase();
  if (s === "PROCESSED") return { text: "Ready", className: "uploaded" };
  if (s === "PROCESSING") return { text: "Processing", className: "pending" };
  if (s === "FAILED") return { text: "Failed", className: "pending" };
  return { text: status || "Unknown", className: "pending" };
}

function Documents() {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load only the documents this user can access (the backend scopes
  // /api/documents to the caller's own uploads + granted access).
  useEffect(() => {
    let cancelled = false;
    async function fetchDocs() {
      try {
        const res = await fetch(`${API_BASE}/api/documents`, {
          headers: authHeaders(),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.message || "Could not load your documents.");
        }
        const data = await res.json();
        if (!cancelled) setDocs(data.documents || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchDocs();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="documents-layout">
      <Sidebar />

      <main className="documents-content">
        <div className="documents-header">
          <h1>Documents</h1>

          <p>Documents you've uploaded or been given access to.</p>
        </div>

        <div className="documents-section">
          <div className="section-header">
            <h2>Your Documents</h2>

            <span>
              {loading
                ? "Loading…"
                : `${docs.length} document${docs.length === 1 ? "" : "s"}`}
            </span>
          </div>

          <div className="documents-list">
            {error && (
              <div className="document-row">
                <div className="document-info">
                  <p>❌ {error}</p>
                </div>
              </div>
            )}

            {!loading && !error && docs.length === 0 && (
              <div className="document-row">
                <div className="document-info">
                  <h3>No documents yet</h3>
                  <p>
                    Upload documents from the SNAP AI Assistant to see them
                    listed here.
                  </p>
                </div>
              </div>
            )}

            {docs.map((d) => {
              const badge = statusLabel(d.status);
              return (
                <div key={d.id} className="document-row">
                  <div className="document-info">
                    <h3>{d.title || d.file_name}</h3>
                    <p>
                      {d.file_name}
                      {d.created_at
                        ? ` · Added ${new Date(d.created_at).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>

                  <div className="document-actions">
                    <span className={`status ${badge.className}`}>
                      {badge.text}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}

export default Documents;
