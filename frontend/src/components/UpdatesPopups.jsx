import { useNavigate } from "react-router-dom";
import { useUpdates } from "../context/UpdatesContext";
import { updateIcon, relativeTime } from "../utils/updates";
import "./Updates.css";

// Transient toasts for freshly-arrived updates. They sit bottom-right, auto-hide
// after 10s (handled by the provider), and open the full Updates page when clicked.
function UpdatesPopups() {
  const { popups, dismissPopup } = useUpdates();
  const navigate = useNavigate();
  if (popups.length === 0) return null;

  return (
    <div className="updates-popups">
      {popups.map((p) => (
        <div
          key={p.id}
          className="update-popup"
          role="status"
          onClick={() => {
            dismissPopup(p.id);
            navigate("/updates");
          }}
        >
          <span className="update-popup-icon">{updateIcon(p.type)}</span>
          <span className="update-popup-body">
            <span className="update-popup-title">{p.title}</span>
            {p.body && <span className="update-popup-text">{p.body}</span>}
            <span className="update-popup-meta">{relativeTime(p.created_at)}</span>
          </span>
          <button
            type="button"
            className="update-popup-close"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismissPopup(p.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export default UpdatesPopups;
