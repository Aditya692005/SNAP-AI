import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import AppShell from "../../components/AppShell";
import { useUpdates } from "../../context/UpdatesContext";
import { updateIcon, relativeTime, isClickableDocument } from "../../utils/updates";
import "./Updates.css";

// The full Updates feed as its own page. Shows every notification — read or
// unread — newest first. Unread rows are visually distinct; clicking a document
// update opens that document, and each row can be removed. "Mark all read" and
// "Clear all" act on the whole feed.
function UpdatesPage() {
  const {
    updates,
    unread,
    refresh,
    markAllRead,
    markOneRead,
    removeUpdate,
    clearAll,
  } = useUpdates();
  const navigate = useNavigate();

  // Pull the freshest feed when the page opens.
  useEffect(() => {
    refresh();
  }, [refresh]);

  function openUpdate(u) {
    if (!u.read_at) markOneRead(u.id);
    if (isClickableDocument(u)) {
      navigate(`/documents?preview=${encodeURIComponent(u.document_id)}`);
    } else if (u.type === "ai_response") {
      navigate("/ai");
    }
  }

  function confirmClear() {
    if (updates.length === 0) return;
    if (window.confirm("Remove all updates? This can't be undone.")) clearAll();
  }

  return (
    <AppShell>
      <div className="updates-page">
        <div className="updates-page-head">
          <div className="updates-page-title">
            <h1>Updates</h1>
            {unread > 0 && <span className="updates-page-count">{unread} unread</span>}
          </div>
          <div className="updates-page-actions">
            {unread > 0 && (
              <button type="button" className="upd-btn" onClick={markAllRead}>
                Mark all read
              </button>
            )}
            {updates.length > 0 && (
              <button type="button" className="upd-btn danger" onClick={confirmClear}>
                Clear all
              </button>
            )}
          </div>
        </div>

        {updates.length === 0 ? (
          <div className="updates-page-empty">
            <span className="updates-page-empty-icon">🔔</span>
            <p>You're all caught up.</p>
            <small>
              Shared documents, retracted files, new metrics and AI replies show up here.
            </small>
          </div>
        ) : (
          <ul className="updates-feed">
            {updates.map((u) => {
              const clickable = isClickableDocument(u) || u.type === "ai_response";
              return (
                <li key={u.id} className={`u-row ${u.read_at ? "read" : "unread"}`}>
                  <div
                    className={`u-row-main ${clickable ? "clickable" : ""}`}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={() => openUpdate(u)}
                    onKeyDown={(e) => {
                      if (clickable && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        openUpdate(u);
                      }
                    }}
                  >
                    {!u.read_at && <span className="u-dot" aria-label="Unread" />}
                    <span className="u-icon">{updateIcon(u.type)}</span>
                    <span className="u-content">
                      <span className="u-title">{u.title}</span>
                      {u.body && <span className="u-text">{u.body}</span>}
                      <span className="u-meta">
                        {relativeTime(u.created_at)}
                        {isClickableDocument(u) && (
                          <span className="u-cta"> · View / download</span>
                        )}
                      </span>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="u-remove"
                    title="Remove this update"
                    aria-label="Remove this update"
                    onClick={() => removeUpdate(u.id)}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </AppShell>
  );
}

export default UpdatesPage;
