import { useEffect } from "react";
import "./Toast.css";

// How long a toast stays on screen before auto-dismissing (ms).
const TOAST_DURATION = 2500;

function ToastItem({ toast, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), TOAST_DURATION);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);

  return (
    <div className={`toast ${toast.type || "success"}`} role="status">
      <span className="toast-icon">
        {toast.type === "error" ? "❌" : "✅"}
      </span>
      <span className="toast-text">{toast.text}</span>
      <button
        type="button"
        className="toast-close"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  );
}

// Stack of transient notification popups, rendered in the top-right corner.
function ToastStack({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

export default ToastStack;
