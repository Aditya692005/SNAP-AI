// Presentation helpers shared by the Updates panel and its popups.

// An emoji glyph per update type (keeps the components free of icon imports and
// consistent between the drawer and the toast).
export function updateIcon(type) {
  switch (type) {
    case "document_shared":
      return "📄";
    case "document_retracted":
      return "🚫";
    case "metric_added":
      return "📊";
    case "ai_response":
      return "🤖";
    default:
      return "🔔";
  }
}

// Compact relative time ("just now", "5m", "3h", "2d", else a date).
export function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// A document update is clickable when its document still exists (document_id set
// — retractions clear it, since there's nothing left to open).
export function isClickableDocument(u) {
  return u?.type === "document_shared" && !!u?.document_id;
}
