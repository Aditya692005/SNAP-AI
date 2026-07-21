// Shared helpers for the in-app document preview (Documents page, AI chat
// sources panel). PDFs use the browser's built-in viewer; txt/csv render as
// text/table; office formats have no native in-browser renderer, so callers
// show a download-only fallback.

export function previewKind(fileName) {
  const ext = String(fileName).slice(String(fileName).lastIndexOf(".") + 1).toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "txt") return "text";
  if (ext === "csv") return "csv";
  return "none";
}

// Minimal RFC-4180-ish CSV parser (quoted fields, embedded commas/newlines).
// Enough for previewing; the authoritative parsing happens server-side.
export function parseCsv(text, maxRows = 500) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }
  if ((field !== "" || row.length > 0) && rows.length < maxRows) {
    row.push(field);
    if (row.some((v) => v !== "")) rows.push(row);
  }
  return rows;
}
