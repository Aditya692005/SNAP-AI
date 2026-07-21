// src/services/documentDownload.js
//
// Serving a document's ORIGINAL bytes back to the browser, with the access check the
// old route was missing.
//
// GET /api/rag/download/:filename used to proxy straight to the RAG service, which
// served anything sitting in its uploads/ directory. It checked that you were logged in
// but never that you could *see that document* — so any user could pull any other
// organization's file just by knowing (or guessing) its name. Both download routes now
// go through canRead() below.

const { accessibleDocumentIds } = require("../models/documentModel");

// Can this user read this document's bytes?
//
// Deliberately the exact same rule as GET /api/documents — including the sub-department
// option for managers/org_admins — so a download link can never reach further than the
// list the user is already shown. Anything not in that set is treated as non-existent.
async function canRead(req, documentId) {
  const ids = await accessibleDocumentIds(req.user.id, req.user.organization_id, {
    subtreeDepartments: (req.user.permissions || []).includes("SHARE_DEPARTMENT_DOCUMENTS"),
  });
  return ids.includes(documentId);
}

// Buffered, not streamed: the Supabase client hands back a whole Blob rather than a
// Node stream, and these are documents (single-digit MB), not video.
function sendBuffer(res, buffer, fileName, mimeType) {
  res.setHeader("Content-Type", mimeType || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${String(fileName).replace(/["\r\n]/g, "")}"`
  );
  res.setHeader("Content-Length", buffer.length);
  return res.send(buffer);
}

module.exports = { canRead, sendBuffer };
