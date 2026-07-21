import { useEffect, useMemo, useState } from "react";
import { documentService } from "../../services/authService";

// Labels for the share tiers the current user is allowed to use. ROLE-based
// sharing ("all managers" / "all employees") is org_admin-only.
const TIERS = [
  { key: "USER", label: "People" },
  { key: "DEPARTMENT", label: "Departments" },
  { key: "ROLE", label: "By role" },
  { key: "ORGANIZATION", label: "Organization" },
];

// "manager" -> "All managers", "employee" -> "All employees".
function roleLabel(name) {
  const n = (name || "").replace(/_/g, " ");
  return `All ${n}${n.endsWith("s") ? "" : "s"}`;
}

function targetLabel(a) {
  if (a.access_type === "USER")
    return a.user ? `${a.user.name} (${a.user.email})` : "A user";
  if (a.access_type === "DEPARTMENT")
    return a.department ? `${a.department.name} (department)` : "A department";
  if (a.access_type === "ORGANIZATION") return "Entire organization";
  if (a.access_type === "ROLE") return a.role ? roleLabel(a.role.name) : "A role";
  return a.access_type;
}

function expiryLabel(a) {
  if (!a.expires_at) return "Permanent";
  const d = new Date(a.expires_at);
  return d > new Date() ? `Until ${d.toLocaleDateString()}` : "Expired";
}

// Share one or more documents with people / departments / roles / the whole org
// (read-only). People, departments and roles can be multi-selected; each ticked
// target shows as a removable chip above the picker. When exactly one document
// is being shared, existing shares are listed and can be revoked.
function ShareDialog({ docs, targets, onClose, onShared }) {
  const docList = useMemo(() => (Array.isArray(docs) ? docs : docs ? [docs] : []), [docs]);
  const single = docList.length === 1 ? docList[0] : null;

  const can = targets?.can || {};
  const allowedTiers = TIERS.filter((t) => {
    if (t.key === "USER") return can.user;
    if (t.key === "DEPARTMENT") return can.department;
    if (t.key === "ROLE") return can.role && (targets?.roles || []).length > 0;
    return can.organization;
  });

  const [tier, setTier] = useState(allowedTiers[0]?.key || null);
  // Ticked targets, kept per tier so switching tiers doesn't lose a selection.
  // Each entry: { id, label }. ORGANIZATION needs no selection.
  const [sel, setSel] = useState({ USER: [], DEPARTMENT: [], ROLE: [] });
  // Type-ahead filter for the person list — orgs can have too many people to
  // scan a bare dropdown.
  const [personQuery, setPersonQuery] = useState("");
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

  // Existing shares are only meaningful for a single document.
  useEffect(() => {
    if (!single) return;
    let cancelled = false;
    documentService
      .listAccess(single.id)
      .then((list) => {
        if (!cancelled) setAccessList(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [single]);

  // Toggle a target in/out of the current tier's selection.
  function toggle(id, label) {
    setSel((prev) => {
      const cur = prev[tier] || [];
      const exists = cur.some((x) => x.id === id);
      return {
        ...prev,
        [tier]: exists ? cur.filter((x) => x.id !== id) : [...cur, { id, label }],
      };
    });
  }

  function isPicked(id) {
    return (sel[tier] || []).some((x) => x.id === id);
  }

  async function share() {
    setError(null);
    setNotice(null);
    if (!tier) return;
    if (expiryMode === "until" && !expiryDate) return setError("Pick an expiry date.");

    // Build the flat list of (access_type + target) pairs for the current tier.
    let picks = [];
    if (tier === "USER") {
      if (sel.USER.length === 0) return setError("Pick at least one person to share with.");
      picks = sel.USER.map((u) => ({ access_type: "USER", user_id: u.id }));
    } else if (tier === "DEPARTMENT") {
      if (sel.DEPARTMENT.length === 0)
        return setError("Pick at least one department to share with.");
      picks = sel.DEPARTMENT.map((d) => ({ access_type: "DEPARTMENT", department_id: d.id }));
    } else if (tier === "ROLE") {
      if (sel.ROLE.length === 0) return setError("Pick at least one role to share with.");
      picks = sel.ROLE.map((r) => ({ access_type: "ROLE", role_id: r.id }));
    } else if (tier === "ORGANIZATION") {
      picks = [{ access_type: "ORGANIZATION" }];
    }

    const expires_at = expiryMode === "until" ? expiryDate : undefined;

    setBusy(true);
    let created = 0;
    let duplicate = 0;
    let skipped = 0;
    const failures = [];
    try {
      for (const doc of docList) {
        for (const pick of picks) {
          // Sharing a doc back to its own uploader is a no-op the backend rejects.
          if (pick.access_type === "USER" && pick.user_id === doc.uploaded_by_user_id) {
            skipped += 1;
            continue;
          }
          try {
            const data = await documentService.share(doc.id, { ...pick, expires_at });
            if (data.already_shared) duplicate += 1;
            else created += 1;
          } catch (err) {
            failures.push(err.message);
          }
        }
      }

      const parts = [];
      if (created) parts.push(`${created} new share${created === 1 ? "" : "s"}`);
      if (duplicate) parts.push(`${duplicate} already shared`);
      if (skipped) parts.push(`${skipped} skipped (owner)`);
      if (parts.length) setNotice(`Done — ${parts.join(", ")} (read-only).`);
      if (failures.length) {
        setError(`${failures.length} share${failures.length === 1 ? "" : "s"} failed: ${failures[0]}`);
      }

      if (single) setAccessList(await documentService.listAccess(single.id));
      setSel((prev) => ({ ...prev, [tier]: [] }));
      setPersonQuery("");
      if ((created || duplicate) && onShared) onShared({ created, duplicate });
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
      await documentService.revokeAccess(single.id, accessId);
      setAccessList((prev) => prev.filter((a) => a.id !== accessId));
    } catch (err) {
      setError(err.message);
    }
  }

  const chips = tier === "ORGANIZATION" ? [] : sel[tier] || [];

  return (
    <>
      <div className="share-overlay" onClick={onClose} />
      <div className="share-dialog" role="dialog" aria-label="Share documents">
        <div className="share-dialog-header">
          <div>
            <h2>{docList.length > 1 ? `Share ${docList.length} documents` : "Share document"}</h2>
            <span className="share-dialog-sub">
              📄{" "}
              {docList.length > 1
                ? `${docList.length} documents selected`
                : single?.title || single?.file_name}{" "}
              · recipients get read-only access
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
                  onClick={() => setTier(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Selected-target chip bar (people / departments / roles). */}
            {chips.length > 0 && (
              <div className="share-chips" aria-label="Selected recipients">
                {chips.map((c) => (
                  <span key={c.id} className="share-chip">
                    {c.label}
                    <button
                      type="button"
                      className="share-chip-remove"
                      onClick={() => toggle(c.id, c.label)}
                      aria-label={`Remove ${c.label}`}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}

            {tier === "USER" &&
              (() => {
                const q = personQuery.trim().toLowerCase();
                const people = (targets.users || [])
                  // The uploader owns the doc — sharing it to them is a no-op.
                  // Only prune when a single doc is in play (uploaders differ otherwise).
                  .filter((u) => !single || u.id !== single.uploaded_by_user_id)
                  .filter(
                    (u) =>
                      !q ||
                      (u.name || "").toLowerCase().includes(q) ||
                      (u.email || "").toLowerCase().includes(q)
                  );
                return (
                  <>
                    <input
                      type="search"
                      className="share-person-search"
                      placeholder="Search people by name or email…"
                      value={personQuery}
                      onChange={(e) => setPersonQuery(e.target.value)}
                      aria-label="Search people"
                    />
                    <div className="share-people-list">
                      {people.length === 0 ? (
                        <p className="share-people-empty">
                          {q
                            ? `No one in your organization matches "${personQuery.trim()}".`
                            : "No one to share with yet."}
                        </p>
                      ) : (
                        people.map((u) => (
                          <button
                            key={u.id}
                            type="button"
                            className={`share-person ${isPicked(u.id) ? "active" : ""}`}
                            onClick={() => toggle(u.id, u.name)}
                            aria-pressed={isPicked(u.id)}
                          >
                            <span className="share-person-name">{u.name}</span>
                            <span className="share-person-email">{u.email}</span>
                            {isPicked(u.id) && <span className="share-person-tick">✓</span>}
                          </button>
                        ))
                      )}
                    </div>
                  </>
                );
              })()}

            {tier === "DEPARTMENT" && (
              <div className="share-people-list">
                {(targets.departments || []).length === 0 ? (
                  <p className="share-people-empty">No departments to share with.</p>
                ) : (
                  (targets.departments || []).map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={`share-person ${isPicked(d.id) ? "active" : ""}`}
                      onClick={() => toggle(d.id, d.name)}
                      aria-pressed={isPicked(d.id)}
                    >
                      <span className="share-person-name">{d.name}</span>
                      {isPicked(d.id) && <span className="share-person-tick">✓</span>}
                    </button>
                  ))
                )}
              </div>
            )}

            {tier === "ROLE" && (
              <div className="share-people-list">
                {(targets.roles || []).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`share-person ${isPicked(r.id) ? "active" : ""}`}
                    onClick={() => toggle(r.id, roleLabel(r.name))}
                    aria-pressed={isPicked(r.id)}
                  >
                    <span className="share-person-name">{roleLabel(r.name)}</span>
                    {isPicked(r.id) && <span className="share-person-tick">✓</span>}
                  </button>
                ))}
              </div>
            )}

            {tier === "ORGANIZATION" && (
              <p className="share-org-note">
                Everyone in your organization will be able to read
                {docList.length > 1 ? " these documents." : " this document."}
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
              {busy ? "Sharing…" : chips.length > 1 ? `Share with ${chips.length}` : "Share"}
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

        {single && (
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
        )}
      </div>
    </>
  );
}

export default ShareDialog;
