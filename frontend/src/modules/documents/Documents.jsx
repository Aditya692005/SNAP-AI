import { useEffect, useRef, useState } from "react";
import AppShell from "../../components/AppShell";
import ToastStack from "../../components/Toast";
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
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null); // { done, total }
  const [deletingId, setDeletingId] = useState(null);
  // Transient popup notifications (auto-dismiss after a few seconds).
  const [toasts, setToasts] = useState([]);

  const fileRef = useRef(null);
  const toastIdRef = useRef(0);

  function notify(text, type = "success") {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, text, type }]);
  }

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  // Only the documents this user can access (the backend scopes /api/documents
  // to the caller's own uploads + granted access).
  async function refreshDocs() {
    const documents = await documentService.list();
    setDocs(documents);
  }

  // Load documents plus what the user is allowed to share to.
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

  // Share/Delete show on documents this user uploaded, or on every document
  // for org_admins. The backend re-enforces all of this server-side.
  function canManage(d) {
    return targets && (targets.is_admin || d.uploaded_by_user_id === targets.user_id);
  }

  // "report.pdf" → "report (1).pdf" — starting suggestion for the rename prompt.
  function suggestRename(name) {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    return `${base} (1)${ext}`;
  }

  // Upload one file; when a document with the same name already exists, ask the
  // user to update the existing document or rename the new file (re-checked, so
  // a rename that collides again just asks again).
  async function uploadResolvingDuplicates(file) {
    try {
      return await documentService.upload(file);
    } catch (err) {
      if (err.code !== "DUPLICATE_FILENAME") throw err;

      if (err.canOverwrite) {
        const update = window.confirm(
          `A document named "${file.name}" already exists.\n\n` +
            "OK — update the existing document with this file (charts built from it can be refreshed).\n" +
            "Cancel — keep both by renaming the new file."
        );
        if (update) return documentService.upload(file, { overwrite: true });
      } else {
        window.alert(
          `"${file.name}" was already uploaded by someone else in your organization — give your file a different name.`
        );
      }

      const newName = window.prompt(
        `New name for "${file.name}":`,
        suggestRename(file.name)
      );
      if (!newName || !newName.trim() || newName.trim() === file.name) {
        throw new Error("upload cancelled", { cause: err });
      }
      const renamed = new File([file], newName.trim(), { type: file.type });
      return uploadResolvingDuplicates(renamed);
    }
  }

  // Upload one or more documents into the AI pipeline. The backend accepts a
  // single file per request, so we upload sequentially (same as the AI page).
  async function handleUpload(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setUploading(true);
    setUploadProgress({ done: 0, total: files.length });

    const succeeded = [];
    const failed = [];
    for (const file of files) {
      try {
        const data = await uploadResolvingDuplicates(file);
        succeeded.push(data.filename || file.name);
      } catch (err) {
        if (err.message !== "upload cancelled") {
          failed.push({ filename: file.name, error: err.message });
        }
      } finally {
        setUploadProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    }

    if (succeeded.length > 0) {
      notify(
        succeeded.length === 1
          ? `Added "${succeeded[0]}".`
          : `Added ${succeeded.length} documents:\n${succeeded.join(", ")}`
      );
    }
    if (failed.length > 0) {
      notify(
        `${failed.length} upload${failed.length > 1 ? "s" : ""} failed:\n${failed
          .map((f) => `${f.filename} — ${f.error}`)
          .join("\n")}`,
        "error"
      );
    }

    try {
      await refreshDocs();
    } catch {
      /* list refresh is best-effort — the uploads themselves already finished */
    }
    setUploading(false);
    setUploadProgress(null);
    e.target.value = "";
  }

  // Remove a document everywhere (DB, AI vectors, dashboard metrics).
  async function handleDelete(d) {
    if (
      !window.confirm(
        `Delete "${d.file_name}" from the AI, database, and dashboard? This cannot be undone.`
      )
    ) {
      return;
    }
    setDeletingId(d.id);
    try {
      await documentService.remove(d.id);
      setDocs((prev) => prev.filter((x) => x.id !== d.id));
      notify(`Deleted "${d.file_name}".`);
    } catch (err) {
      notify(err.message, "error");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <AppShell>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <div className="documents-content">
        <div className="documents-header">
          <h1>Documents</h1>

          <p>Documents you've uploaded or been given access to.</p>
        </div>

        <div className="documents-section">
          <div className="section-header">
            <h2>Your Documents</h2>

            <div className="section-header-actions">
              <span>
                {loading
                  ? "Loading…"
                  : `${docs.length} document${docs.length === 1 ? "" : "s"}`}
              </span>
              <button
                type="button"
                className="upload-button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                {uploading
                  ? uploadProgress
                    ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
                    : "Uploading…"
                  : "＋ Add documents"}
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".pdf,.csv,.txt,.xlsx,.xls,.docx,.pptx"
                style={{ display: "none" }}
                onChange={handleUpload}
              />
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

            {!loading && !error && docs.length === 0 && (
              <div className="document-row">
                <div className="document-info">
                  <h3>No documents yet</h3>
                  <p>
                    Use "＋ Add documents" above (or upload from the SNAP AI
                    Assistant) to see them listed here.
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
                    {canManage(d) && (
                      <button
                        type="button"
                        className="share-button"
                        onClick={() => setShareDoc(d)}
                        title="Share this document (read-only)"
                      >
                        ⤴ Share
                      </button>
                    )}
                    {canManage(d) && (
                      <button
                        type="button"
                        className="delete-button"
                        onClick={() => handleDelete(d)}
                        disabled={deletingId === d.id}
                        title="Delete this document everywhere"
                      >
                        {deletingId === d.id ? "Deleting…" : "🗑 Delete"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {shareDoc && (
        <ShareDialog
          doc={shareDoc}
          targets={targets}
          onClose={() => setShareDoc(null)}
        />
      )}
    </AppShell>
  );
}

export default Documents;
