import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Sidebar from "../../components/Sidebar";
import ChartBlock from "../ai/ChartBlock";
import { organizationService } from "../../services/authService";
import "./Dashboard.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem("token")}` };
}

// The personal dashboard is a board of charts the user pinned from the AI
// Assistant (widget_type "ai_chart"). Nothing is auto-added; a widget only
// appears when the user explicitly pins a chart. When a document is re-uploaded
// with new data, charts built from it are flagged stale (config.stale) and the
// user can refresh them on demand.
//
// A user can keep several dashboards to organise their pins. The one they last
// had open is remembered in localStorage so pinning from the AI Assistant lands
// on the same board.
const ACTIVE_KEY = "activeDashboardId";

function Dashboard() {
  const [dashboards, setDashboards] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [widgets, setWidgets] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshingId, setRefreshingId] = useState(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [creating, setCreating] = useState(false); // inline "new dashboard" input
  const [renaming, setRenaming] = useState(false); // inline rename of active board
  const [draftName, setDraftName] = useState("");

  // Department dashboards: shared boards scoped to a department. The server
  // decides which the user can see and whether they can edit (can_edit).
  const [scope, setScope] = useState("personal"); // "personal" | "department"
  const [deptBoards, setDeptBoards] = useState([]);
  const [activeDeptId, setActiveDeptId] = useState(null);
  const [deptWidgets, setDeptWidgets] = useState([]);
  const [deptCanEdit, setDeptCanEdit] = useState(false);
  const [deptLoading, setDeptLoading] = useState(false);
  const [deptRefreshingId, setDeptRefreshingId] = useState(null);
  const [deptRenaming, setDeptRenaming] = useState(false);

  const deptActive = deptBoards.find((b) => b.id === activeDeptId) || null;

  useEffect(() => {
    loadDashboards();
    loadDepartmentBoards();
    refreshDocuments();
    organizationService.get().then(setOrg).catch(() => {});
  }, []);

  // Fetch this dashboard's widgets whenever the active board changes, and
  // remember the choice so the AI Assistant pins to the same board.
  useEffect(() => {
    if (!activeId) return;
    localStorage.setItem(ACTIVE_KEY, activeId);
    refreshWidgets(activeId);
  }, [activeId]);

  // Load the active department board's widgets whenever it changes.
  useEffect(() => {
    if (activeDeptId) refreshDeptWidgets(activeDeptId);
  }, [activeDeptId]);

  // Since there's no realtime, re-pull the active department board when the tab
  // regains focus — shrinks the window in which another editor's change (or the
  // re-upload stale flag) goes unseen before you act on it.
  useEffect(() => {
    if (scope !== "department" || !activeDeptId) return;
    const onFocus = () => refreshDeptWidgets(activeDeptId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [scope, activeDeptId]);

  const active = dashboards.find((d) => d.id === activeId) || null;

  async function loadDashboards() {
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/dashboards`, { headers: authHeaders() });
      if (!res.ok) return;
      const list = (await res.json()).dashboards || [];
      setDashboards(list);
      const stored = localStorage.getItem(ACTIVE_KEY);
      const pick =
        list.find((d) => d.id === stored) || list.find((d) => d.is_default) || list[0];
      setActiveId(pick ? pick.id : null);
    } catch {
      // leave empty state
    }
  }

  async function refreshWidgets(id) {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/widgets?dashboard_id=${id}`, {
        headers: authHeaders(),
      });
      if (res.ok) setWidgets((await res.json()).widgets || []);
    } catch {
      // leave empty state
    } finally {
      setLoading(false);
    }
  }

  async function refreshDocuments() {
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/documents`, { headers: authHeaders() });
      if (res.ok) setDocuments((await res.json()).documents || []);
    } catch {
      // leave empty state
    }
  }

  function refresh() {
    if (activeId) refreshWidgets(activeId);
    refreshDocuments();
  }

  async function createDashboard(name) {
    const clean = (name || "").trim();
    if (!clean) return;
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/dashboards`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name: clean }),
      });
      if (!res.ok) throw new Error();
      const created = await res.json();
      setDashboards((prev) => [...prev, created]);
      setActiveId(created.id); // jump to the new board
      setCreating(false);
      setDraftName("");
    } catch {
      window.alert("Could not create the dashboard.");
    }
  }

  async function renameDashboard(d, name) {
    const clean = (name || "").trim();
    if (!clean || clean === d.name) {
      setRenaming(false);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/dashboards/${d.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name: clean }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setDashboards((prev) => prev.map((x) => (x.id === d.id ? updated : x)));
      setRenaming(false);
    } catch {
      window.alert("Could not rename the dashboard.");
    }
  }

  async function deleteDashboard(d) {
    if (d.is_default) return;
    if (
      !window.confirm(`Delete "${d.name}"? Every chart pinned to it will be removed.`)
    ) {
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/dashboards/${d.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error();
      const remaining = dashboards.filter((x) => x.id !== d.id);
      setDashboards(remaining);
      if (activeId === d.id) {
        const fallback = remaining.find((x) => x.is_default) || remaining[0];
        setActiveId(fallback ? fallback.id : null);
      }
    } catch {
      window.alert("Could not delete the dashboard.");
    }
  }

  async function removeWidget(id) {
    const prev = widgets;
    setWidgets((w) => w.filter((x) => x.id !== id));
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/widgets/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error();
    } catch {
      setWidgets(prev); // restore on failure
    }
  }

  // Regenerate one stale chart against the latest data (reruns the LLM server-side).
  async function refreshWidget(id) {
    setRefreshingId(id);
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/widgets/${id}/refresh`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (res.ok) {
        const updated = await res.json();
        setWidgets((w) => w.map((x) => (x.id === id ? updated : x)));
      }
    } catch {
      // leave the widget as-is (still marked stale) on failure
    } finally {
      setRefreshingId(null);
    }
  }

  // ── Department dashboards ────────────────────────────────────────────────────
  async function loadDepartmentBoards() {
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/department`, { headers: authHeaders() });
      if (!res.ok) return;
      const list = (await res.json()).dashboards || [];
      setDeptBoards(list);
      // Default to the user's editable board if they have one, else the first.
      setActiveDeptId((cur) => cur || (list.find((b) => b.can_edit) || list[0])?.id || null);
    } catch {
      // no department boards visible — the switcher stays hidden
    }
  }

  async function refreshDeptWidgets(id) {
    setDeptLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/department/${id}/widgets`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setDeptWidgets(data.widgets || []);
        setDeptCanEdit(!!data.can_edit);
        // Keep the board's version (for rename) in step with the server.
        setDeptBoards((prev) =>
          prev.map((b) => (b.id === id ? { ...b, version: data.version, can_edit: data.can_edit } : b))
        );
      }
    } catch {
      // leave as-is
    } finally {
      setDeptLoading(false);
    }
  }

  // A shared board changed underneath us (409). Tell the user and re-pull.
  function handleDeptConflict() {
    window.alert("This board was just changed by someone else — reloading the latest version.");
    if (activeDeptId) refreshDeptWidgets(activeDeptId);
  }

  async function removeDeptWidget(w) {
    if (!window.confirm("Remove this chart from the department dashboard?")) return;
    const prev = deptWidgets;
    setDeptWidgets((list) => list.filter((x) => x.id !== w.id));
    try {
      const res = await fetch(
        `${API_BASE}/api/dashboard/department/widgets/${w.id}?expected_version=${w.version}`,
        { method: "DELETE", headers: authHeaders() }
      );
      if (res.status === 409) {
        setDeptWidgets(prev);
        handleDeptConflict();
      } else if (!res.ok) {
        setDeptWidgets(prev);
      }
    } catch {
      setDeptWidgets(prev);
    }
  }

  async function refreshDeptWidget(w) {
    setDeptRefreshingId(w.id);
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/department/widgets/${w.id}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ expected_version: w.version }),
      });
      if (res.status === 409) {
        handleDeptConflict();
      } else if (res.ok) {
        const updated = await res.json();
        setDeptWidgets((list) => list.map((x) => (x.id === w.id ? updated : x)));
      }
    } catch {
      // leave stale on failure
    } finally {
      setDeptRefreshingId(null);
    }
  }

  async function renameDeptBoard(board, name) {
    const clean = (name || "").trim();
    setDeptRenaming(false);
    if (!clean || clean === board.name) return;
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/department/${board.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name: clean, expected_version: board.version }),
      });
      if (res.status === 409) {
        handleDeptConflict();
      } else if (res.ok) {
        const updated = await res.json();
        setDeptBoards((prev) => prev.map((b) => (b.id === board.id ? { ...b, ...updated } : b)));
      }
    } catch {
      // leave name as-is
    }
  }

  async function toggleDocument(source, included) {
    setDocuments((prev) =>
      prev.map((d) => (d.source_document === source ? { ...d, included } : d))
    );
    try {
      await fetch(`${API_BASE}/api/dashboard/documents/${encodeURIComponent(source)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ included }),
      });
    } catch {
      setDocuments((prev) =>
        prev.map((d) => (d.source_document === source ? { ...d, included: !included } : d))
      );
    }
  }

  async function removeDocument(source) {
    if (
      !window.confirm(
        `Remove "${source}" from the dashboard? Its extracted data will be deleted.`
      )
    ) {
      return;
    }
    const prevDocs = documents;
    setDocuments((prev) => prev.filter((d) => d.source_document !== source));
    try {
      await fetch(`${API_BASE}/api/dashboard/documents/${encodeURIComponent(source)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
    } catch {
      setDocuments(prevDocs); // restore on failure
    }
  }

  const includedCount = documents.filter((d) => d.included).length;

  return (
    <div className="dashboard">
      <Sidebar />

      <main className="dashboard-content">
        {/* Header */}
        <div className="dashboard-header">
          <div className="dashboard-title-wrap">
            <span className="dashboard-eyebrow">SNAP AI · {org?.name || "Studio"}</span>
            <h1>{org?.name ? `${org.name} — Insights Dashboard` : "Insights Dashboard"}</h1>
            <p>
              {org?.description ||
                "Charts you pin from the AI Assistant live here — ask for a chart, then pin it."}
            </p>
            {org && (org.industry || org.country || org.subscription_plan) && (
              <p className="dashboard-org-meta">
                {[org.industry, org.country, org.subscription_plan]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>

          <div className="dashboard-toolbar">
            <button className="ghost-btn" onClick={refresh} disabled={loading}>
              ⟳ Refresh
            </button>
            <button className="sources-btn" onClick={() => setSourcesOpen(true)}>
              <span className="chip-dot" /> Sources
              <span className="sources-count">
                {includedCount}/{documents.length}
              </span>
            </button>
          </div>
        </div>

        {/* Scope switch — only shown when the user can see a department board */}
        {deptBoards.length > 0 && (
          <div className="scope-switch">
            <button
              className={`scope-btn ${scope === "personal" ? "active" : ""}`}
              onClick={() => setScope("personal")}
            >
              My dashboards
            </button>
            <button
              className={`scope-btn ${scope === "department" ? "active" : ""}`}
              onClick={() => setScope("department")}
            >
              Department
            </button>
          </div>
        )}

        {scope === "personal" && (
          <>
        {/* Dashboard tabs — switch between the user's personal dashboards */}
        <div className="dashboard-tabs">
          {dashboards.map((d) => (
            <button
              key={d.id}
              className={`dash-tab ${d.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(d.id)}
            >
              <span className="dash-tab-name">{d.name}</span>
              {d.is_default && <span className="dash-tab-badge">default</span>}
            </button>
          ))}

          {creating ? (
            <input
              className="dash-tab-input"
              autoFocus
              placeholder="Dashboard name…"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createDashboard(draftName);
                if (e.key === "Escape") {
                  setCreating(false);
                  setDraftName("");
                }
              }}
              onBlur={() => {
                setCreating(false);
                setDraftName("");
              }}
            />
          ) : (
            <button
              className="dash-tab new"
              onClick={() => {
                setDraftName("");
                setCreating(true);
              }}
              title="New dashboard"
            >
              + New
            </button>
          )}
        </div>

        {active && (
          <div className="dashboard-board-actions">
            {renaming ? (
              <input
                className="dash-rename-input"
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") renameDashboard(active, draftName);
                  if (e.key === "Escape") setRenaming(false);
                }}
                onBlur={() => renameDashboard(active, draftName)}
              />
            ) : (
              <button
                className="ghost-btn small"
                onClick={() => {
                  setDraftName(active.name);
                  setRenaming(true);
                }}
              >
                ✎ Rename
              </button>
            )}
            {!active.is_default && !renaming && (
              <button
                className="ghost-btn small danger"
                onClick={() => deleteDashboard(active)}
              >
                🗑 Delete
              </button>
            )}
          </div>
        )}

        {loading && <div className="dashboard-empty">Loading dashboard…</div>}

        {!loading && widgets.length === 0 && (
          <div className="welcome-card">
            <h2>No charts pinned yet</h2>
            <p>
              Head to the AI Assistant, ask for a chart (e.g. “bar chart of sales
              by region”), and pin it — it’ll show up here on your dashboard.
            </p>
            <Link to="/ai" className="upload-btn">Open AI Assistant</Link>
          </div>
        )}

        {/* Pinned charts */}
        {!loading && widgets.length > 0 && (
          <div className="dashboard-charts">
            {widgets.map((w) => {
              const spec = w.config?.spec;
              const stale = !!w.config?.stale;
              if (!spec) return null;
              return (
                <div className={`chart-panel ${stale ? "stale" : ""}`} key={w.id}>
                  {stale && (
                    <div className="widget-stale-bar">
                      <span>
                        ⚠ The source document changed — this chart may be out of date.
                      </span>
                      <button
                        className="ghost-btn small"
                        onClick={() => refreshWidget(w.id)}
                        disabled={refreshingId === w.id}
                      >
                        {refreshingId === w.id ? "Refreshing…" : "↻ Refresh"}
                      </button>
                    </div>
                  )}
                  <ChartBlock spec={spec} onRemove={() => removeWidget(w.id)} />
                </div>
              );
            })}
          </div>
        )}
          </>
        )}

        {/* Department dashboards — shared, read-only unless you can edit */}
        {scope === "department" && (
          <>
            <div className="dashboard-tabs">
              {deptBoards.map((b) => (
                <button
                  key={b.id}
                  className={`dash-tab ${b.id === activeDeptId ? "active" : ""}`}
                  onClick={() => setActiveDeptId(b.id)}
                >
                  <span className="dash-tab-name">{b.department_name}</span>
                  {!b.can_edit && <span className="dash-tab-badge">view</span>}
                </button>
              ))}
            </div>

            {deptActive && (
              <div className="dashboard-board-actions">
                {deptActive.can_edit && !deptRenaming && (
                  <button
                    className="ghost-btn small"
                    onClick={() => {
                      setDraftName(deptActive.name);
                      setDeptRenaming(true);
                    }}
                  >
                    ✎ Rename
                  </button>
                )}
                {deptActive.can_edit && deptRenaming && (
                  <input
                    className="dash-rename-input"
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameDeptBoard(deptActive, draftName);
                      if (e.key === "Escape") setDeptRenaming(false);
                    }}
                    onBlur={() => renameDeptBoard(deptActive, draftName)}
                  />
                )}
                {!deptActive.can_edit && (
                  <span className="dash-readonly-hint">
                    View only — managed by this department’s manager
                  </span>
                )}
                {deptActive.updated_at && (
                  <span className="dash-updated-hint">
                    Last updated {new Date(deptActive.updated_at).toLocaleDateString()}
                  </span>
                )}
              </div>
            )}

            {deptLoading && <div className="dashboard-empty">Loading dashboard…</div>}

            {!deptLoading && deptWidgets.length === 0 && (
              <div className="welcome-card">
                <h2>No charts on this department dashboard yet</h2>
                <p>
                  {deptCanEdit
                    ? "Ask the AI Assistant for a chart, then pin it to this department board."
                    : "Your department manager hasn’t pinned any charts here yet."}
                </p>
                {deptCanEdit && (
                  <Link to="/ai" className="upload-btn">Open AI Assistant</Link>
                )}
              </div>
            )}

            {!deptLoading && deptWidgets.length > 0 && (
              <div className="dashboard-charts">
                {deptWidgets.map((w) => {
                  const spec = w.config?.spec;
                  const stale = !!w.config?.stale;
                  if (!spec) return null;
                  return (
                    <div className={`chart-panel ${stale ? "stale" : ""}`} key={w.id}>
                      {stale && (
                        <div className="widget-stale-bar">
                          <span>
                            ⚠ The source document changed — this chart may be out of date.
                          </span>
                          {deptCanEdit && (
                            <button
                              className="ghost-btn small"
                              onClick={() => refreshDeptWidget(w)}
                              disabled={deptRefreshingId === w.id}
                            >
                              {deptRefreshingId === w.id ? "Refreshing…" : "↻ Refresh"}
                            </button>
                          )}
                        </div>
                      )}
                      <ChartBlock
                        spec={spec}
                        onRemove={deptCanEdit ? () => removeDeptWidget(w) : undefined}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>

      {/* Data sources drawer */}
      <div
        className={`sources-overlay ${sourcesOpen ? "open" : ""}`}
        onClick={() => setSourcesOpen(false)}
      />
      <aside className={`sources-drawer ${sourcesOpen ? "open" : ""}`} aria-hidden={!sourcesOpen}>
        <div className="drawer-header">
          <div>
            <h2>Data sources</h2>
            <span className="sources-hint">Documents available to the AI &amp; dashboard</span>
          </div>
          <button className="drawer-close" onClick={() => setSourcesOpen(false)} aria-label="Close sources">
            ✕
          </button>
        </div>

        {documents.length === 0 ? (
          <div className="dashboard-empty">No documents uploaded yet.</div>
        ) : (
          <div className="sources-list">
            {documents.map((doc) => (
              <div
                className={`source-row ${doc.included ? "included" : ""}`}
                key={doc.source_document}
              >
                <div className="source-info">
                  <span className="source-name">📄 {doc.source_document}</span>
                  <span className={`source-status ${doc.status}`}>{doc.status}</span>
                </div>
                <div className="source-actions">
                  <label className="source-toggle" title="Include this document's data">
                    <input
                      type="checkbox"
                      checked={doc.included}
                      onChange={(e) => toggleDocument(doc.source_document, e.target.checked)}
                    />
                    <span className="switch" />
                    <span className="switch-label">
                      {doc.included ? "Included" : "Excluded"}
                    </span>
                  </label>
                  <button
                    type="button"
                    className="source-remove"
                    title="Remove this document"
                    onClick={() => removeDocument(doc.source_document)}
                  >
                    🗑 Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

export default Dashboard;
