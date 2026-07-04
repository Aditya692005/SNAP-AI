import { useEffect, useState } from "react";
import Sidebar from "../../components/Sidebar";
import ShareDialog from "./ShareDialog";
import { documentService } from "../../services/authService";
import "./Documents.css";

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
  // Share tiers + pick-lists for the current user, from /api/documents/share-targets.
  const [targets, setTargets] = useState(null);
  const [shareDoc, setShareDoc] = useState(null); // doc whose share dialog is open

  // Load only the documents this user can access (the backend scopes
  // /api/documents to the caller's own uploads + granted access), plus what
  // they're allowed to share to.
  useEffect(() => {
    let cancelled = false;
    async function fetchAll() {
      try {
        const [documents, shareTargets] = await Promise.all([
          documentService.list(),
          documentService.shareTargets().catch(() => null),
        ]);
        if (!cancelled) {
          setDocs(documents);
          setTargets(shareTargets);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchAll();
    return () => {
      cancelled = true;
    };
  }, []);

  // Share button shows on documents this user uploaded, or on every document
  // for org_admins. The backend re-enforces all of this server-side.
  function canShare(d) {
    return targets && (targets.is_admin || d.uploaded_by_user_id === targets.user_id);
  }

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
                    {canShare(d) && (
                      <button
                        type="button"
                        className="share-button"
                        onClick={() => setShareDoc(d)}
                        title="Share this document (read-only)"
                      >
                        ⤴ Share
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </main>

      {shareDoc && (
        <ShareDialog
          doc={shareDoc}
          targets={targets}
          onClose={() => setShareDoc(null)}
        />
      )}
    </div>
  );
}

export default Documents;
