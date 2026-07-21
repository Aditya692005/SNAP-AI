import { useEffect, useRef } from "react";
import "./Toast.css";

// How long a toast stays on screen before auto-dismissing (ms).
const TOAST_DURATION = 2500;

function ToastItem({ toast, onDismiss }) {
  // Read the latest onDismiss through a ref so the auto-dismiss timer is armed
  // exactly once per toast (keyed on toast.id) and is never reset when the
  // parent re-renders with a new onDismiss identity — while still invoking the
  // current handler, not a stale closure.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    const timer = setTimeout(() => onDismissRef.current(toast.id), TOAST_DURATION);
    return () => clearTimeout(timer);
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
