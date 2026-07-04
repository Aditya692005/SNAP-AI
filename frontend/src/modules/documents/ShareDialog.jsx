import { useEffect, useState } from "react";
import { documentService } from "../../services/authService";

// Labels for the share tiers the current user is allowed to use. ROLE-based
// sharing exists in the backend (org_admin, API-only) but is deliberately not
// offered here.
const TIERS = [
  { key: "USER", label: "Person" },
  { key: "DEPARTMENT", label: "Department" },
  { key: "ORGANIZATION", label: "Organization" },
];

function targetLabel(a) {
  if (a.access_type === "USER")
    return a.user ? `${a.user.name} (${a.user.email})` : "A user";
  if (a.access_type === "DEPARTMENT")
    return a.department ? `${a.department.name} (department)` : "A department";
  if (a.access_type === "ORGANIZATION") return "Entire organization";
  if (a.access_type === "ROLE") return a.role ? `Role: ${a.role.name}` : "A role";
  return a.access_type;
}

function expiryLabel(a) {
  if (!a.expires_at) return "Permanent";
  const d = new Date(a.expires_at);
  return d > new Date() ? `Until ${d.toLocaleDateString()}` : "Expired";
}

// Share a document with a person / department / the whole org (read-only),
// permanently or until a date — and see + revoke existing shares.
function ShareDialog({ doc, targets, onClose }) {
  const can = targets?.can || {};
  const allowedTiers = TIERS.filter((t) => {
    if (t.key === "USER") return can.user;
    if (t.key === "DEPARTMENT") return can.department;
    return can.organization;
  });

  const [tier, setTier] = useState(allowedTiers[0]?.key || null);
  const [targetId, setTargetId] = useState("");
  const [expiryMode, setExpiryMode] = useState("permanent"); // "permanent" | "until"
  const [expiryDate, setExpiryDate] = useState("");
  const [accessList, setAccessList] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // Earliest pickable expiry (tomorrow), computed once when the dialog opens.
  const [minExpiry] = useState(() =>
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );

  useEffect(() => {
    let cancelled = false;
    documentService
      .listAccess(doc.id)
      .then((list) => {
        if (!cancelled) setAccessList(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [doc.id]);

  async function share() {
    setError(null);
    setNotice(null);
    if (!tier) return;
    if (tier === "USER" && !targetId) return setError("Pick a person to share with.");
    if (tier === "DEPARTMENT" && !targetId) return setError("Pick a department to share with.");
    if (expiryMode === "until" && !expiryDate) return setError("Pick an expiry date.");

    const payload = { access_type: tier };
    if (tier === "USER") payload.user_id = targetId;
    if (tier === "DEPARTMENT") payload.department_id = targetId;
    if (expiryMode === "until") payload.expires_at = expiryDate;

    setBusy(true);
    try {
      const data = await documentService.share(doc.id, payload);
      setNotice(
        data.already_shared
          ? "Already shared with that target — no duplicate added."
          : "Shared (read-only)."
      );
      setAccessList(await documentService.listAccess(doc.id));
      setTargetId("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(accessId) {
    setError(null);
    setNotice(null);
    try {
      await documentService.revokeAccess(doc.id, accessId);
      setAccessList((prev) => prev.filter((a) => a.id !== accessId));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="share-overlay" onClick={onClose} />
      <div className="share-dialog" role="dialog" aria-label={`Share ${doc.file_name}`}>
        <div className="share-dialog-header">
          <div>
            <h2>Share document</h2>
            <span className="share-dialog-sub">
              📄 {doc.title || doc.file_name} · recipients get read-only access
            </span>
          </div>
          <button className="share-close" onClick={onClose} aria-label="Close share dialog">
            ✕
          </button>
        </div>

        {allowedTiers.length > 0 ? (
          <div className="share-form">
            <div className="share-tiers">
              {allowedTiers.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`share-tier ${tier === t.key ? "active" : ""}`}
                  onClick={() => {
                    setTier(t.key);
                    setTargetId("");
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tier === "USER" && (
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">Select a person…</option>
                {(targets.users || []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </select>
            )}

            {tier === "DEPARTMENT" && (
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">Select a department…</option>
                {(targets.departments || []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}

            {tier === "ORGANIZATION" && (
              <p className="share-org-note">
                Everyone in your organization will be able to read this document.
              </p>
            )}

            <div className="share-expiry">
              <label>
                <input
                  type="radio"
                  name="share-expiry"
                  checked={expiryMode === "permanent"}
                  onChange={() => setExpiryMode("permanent")}
                />
                Permanent
              </label>
              <label>
                <input
                  type="radio"
                  name="share-expiry"
                  checked={expiryMode === "until"}
                  onChange={() => setExpiryMode("until")}
                />
                Until
                <input
                  type="date"
                  value={expiryDate}
                  min={minExpiry}
                  onChange={(e) => {
                    setExpiryDate(e.target.value);
                    setExpiryMode("until");
                  }}
                />
              </label>
            </div>

            <button className="share-submit" onClick={share} disabled={busy}>
              {busy ? "Sharing…" : "Share"}
            </button>
          </div>
        ) : (
          <p className="share-org-note">
            You don't have permission to share documents, but you can review and revoke
            existing shares below.
          </p>
        )}

        {error && <div className="share-error">❌ {error}</div>}
        {notice && <div className="share-notice">✅ {notice}</div>}

        <div className="share-access">
          <h3>Shared with</h3>
          {accessList.length === 0 ? (
            <p className="share-access-empty">Not shared with anyone yet.</p>
          ) : (
            accessList.map((a) => (
              <div key={a.id} className="share-access-row">
                <div className="share-access-info">
                  <span className="share-access-target">{targetLabel(a)}</span>
                  <span className="share-access-expiry">
                    {expiryLabel(a)}
                    {a.granted_by ? ` · shared by ${a.granted_by.name}` : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="share-revoke"
                  onClick={() => revoke(a.id)}
                  title="Revoke this access"
                >
                  Revoke
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

export default ShareDialog;
