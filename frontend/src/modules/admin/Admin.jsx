import { useEffect, useMemo, useState } from "react";
import AppShell from "../../components/AppShell";
import { adminService, authService } from "../../services/authService";
import "./Admin.css";

const ROLE_LABELS = { employee: "Employee", manager: "Manager", org_admin: "Company Admin" };
const roleLabel = (name) => ROLE_LABELS[name] || name;

// Group permissions into readable sections, and turn ACTION_NAMES into prose.
const GROUP_ORDER = ["Administration", "Documents", "AI Assistant", "Dashboards"];
function permGroup(action) {
  if (action.includes("DOCUMENT")) return "Documents";
  if (action.includes("DASHBOARD")) return "Dashboards";
  if (action.includes("AI")) return "AI Assistant";
  return "Administration";
}
function humanizePerm(action) {
  return action
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function Admin() {
  const me = authService.getUser();
  const [tab, setTab] = useState("users");
  const [users, setUsers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [roles, setRoles] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [invite, setInvite] = useState({ email: "", name: "", role_id: "", department_id: "" });
  const [newDept, setNewDept] = useState({ name: "", description: "" });
  const [editDept, setEditDept] = useState({ id: null, name: "", description: "" });
  const [roleForm, setRoleForm] = useState({ name: "", description: "", permissions: [] });
  const [deptToDelete, setDeptToDelete] = useState(null);
  const [deptDeleteMode, setDeptDeleteMode] = useState("reassign");
  const [deptReassignTarget, setDeptReassignTarget] = useState("");

  const roleById = useMemo(() => Object.fromEntries(roles.map((r) => [r.id, r])), [roles]);

  const groupedPerms = useMemo(() => {
    const g = {};
    for (const p of permissions) (g[permGroup(p.action)] ||= []).push(p);
    return g;
  }, [permissions]);

  function toggleGroup(actions, on) {
    setRoleForm((prev) => {
      const set = new Set(prev.permissions);
      actions.forEach((a) => (on ? set.add(a) : set.delete(a)));
      return { ...prev, permissions: [...set] };
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  // Auto-dismiss the success notice after a few seconds (it also fades via CSS).
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [u, d, r, p] = await Promise.all([
        adminService.listUsers(),
        adminService.listDepartments(),
        adminService.listRoles(),
        adminService.listPermissions(),
      ]);
      setUsers(u);
      setDepartments(d);
      setRoles(r);
      setPermissions(p);
      // Default the invite role to "employee" if present.
      const emp = r.find((x) => x.name === "employee");
      setInvite((prev) => ({ ...prev, role_id: prev.role_id || emp?.id || r[0]?.id || "" }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function changeUser(id, fields) {
    try {
      const { user } = await adminService.updateUser(id, fields);
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, ...user } : u)));
    } catch (err) {
      setError(err.message);
    }
  }

  async function deactivate(u) {
    if (!window.confirm(`Deactivate ${u.email}? They will no longer be able to log in.`)) return;
    try {
      await adminService.deactivateUser(u.id);
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, status: "INACTIVE" } : x)));
    } catch (err) {
      setError(err.message);
    }
  }

  async function reactivate(u) {
    try {
      const { user } = await adminService.reactivateUser(u.id);
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, ...user } : x)));
      setNotice(`${u.email} reactivated — they can log in again with their existing password.`);
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeUser(u) {
    if (!window.confirm(`Permanently delete ${u.email}? This cannot be undone.`)) return;
    try {
      await adminService.deleteUser(u.id);
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
    } catch (err) {
      setError(err.message);
    }
  }

  async function inviteUser(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    const email = invite.email.trim().toLowerCase();
    if (!email) return setError("Email is required");
    if (!invite.role_id) return setError("Pick a role");
    try {
      await adminService.inviteUser({
        email,
        name: invite.name.trim() || undefined,
        role_id: invite.role_id,
        department_id: invite.department_id || undefined,
      });
      setNotice(`Invite sent to ${email}.`);
      setInvite((prev) => ({ ...prev, email: "", name: "", department_id: "" }));
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function addDepartment(e) {
    e.preventDefault();
    const name = newDept.name.trim();
    if (!name) return;
    try {
      const { department } = await adminService.createDepartment(
        name,
        newDept.description.trim() || undefined
      );
      setDepartments((prev) =>
        [...prev, department].sort((a, b) => a.name.localeCompare(b.name))
      );
      setNewDept({ name: "", description: "" });
    } catch (err) {
      setError(err.message);
    }
  }

  function startEditDept(d) {
    setEditDept({ id: d.id, name: d.name, description: d.description || "" });
  }
  function cancelEditDept() {
    setEditDept({ id: null, name: "", description: "" });
  }
  async function saveDept() {
    const name = editDept.name.trim();
    if (!name) return setError("Department name can't be empty");
    try {
      const { department } = await adminService.updateDepartment(editDept.id, {
        name,
        description: editDept.description.trim() || null,
      });
      setDepartments((prev) =>
        prev
          .map((d) => (d.id === department.id ? { ...d, ...department } : d))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      cancelEditDept();
    } catch (err) {
      setError(err.message);
    }
  }

  function removeDepartment(d) {
    const active = deptRoleBreakdown(d.id).reduce((s, [, c]) => s + c, 0);
    if (active === 0) {
      if (!window.confirm(`Delete department "${d.name}"?`)) return;
      adminService
        .deleteDepartment(d.id)
        .then(() => setDepartments((prev) => prev.filter((x) => x.id !== d.id)))
        .catch((err) => setError(err.message));
      return;
    }
    // Has active users → ask the admin to reassign or deactivate them.
    const others = departments.filter((x) => x.id !== d.id);
    setDeptDeleteMode(others.length ? "reassign" : "deactivate");
    setDeptReassignTarget(others[0]?.id || "");
    setDeptToDelete(d);
  }

  async function confirmDeleteDept() {
    const d = deptToDelete;
    if (!d) return;
    try {
      if (deptDeleteMode === "reassign") {
        if (!deptReassignTarget) return setError("Pick a department to move users to");
        await adminService.deleteDepartment(d.id, { reassignTo: deptReassignTarget });
      } else {
        await adminService.deleteDepartment(d.id, { deactivate: true });
      }
      setDeptToDelete(null);
      await refresh(); // reflect moved/deactivated users + removed department
    } catch (err) {
      setError(err.message);
    }
  }

  // The role makeup of a department's active users: [["Employee", 2], ...]
  function deptRoleBreakdown(deptId) {
    const counts = {};
    for (const u of users) {
      if (u.department_id !== deptId || u.status === "INACTIVE") continue;
      const label = roleLabel(u.role || "—");
      counts[label] = (counts[label] || 0) + 1;
    }
    return Object.entries(counts);
  }

  async function removeRole(r) {
    if (!window.confirm(`Delete role "${roleLabel(r.name)}"? This can't be undone.`)) return;
    try {
      await adminService.deleteRole(r.id);
      setRoles((prev) => prev.filter((x) => x.id !== r.id));
    } catch (err) {
      setError(err.message);
    }
  }

  function togglePerm(action) {
    setRoleForm((prev) => ({
      ...prev,
      permissions: prev.permissions.includes(action)
        ? prev.permissions.filter((a) => a !== action)
        : [...prev.permissions, action],
    }));
  }

  async function createRole(e) {
    e.preventDefault();
    setError("");
    const name = roleForm.name.trim();
    if (!name) return setError("Role name is required");
    try {
      await adminService.createRole({
        name,
        description: roleForm.description.trim() || undefined,
        permissions: roleForm.permissions,
      });
      setRoleForm({ name: "", description: "", permissions: [] });
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <AppShell>
      <div className="admin-content">
        <div className="admin-header">
          <div>
            <span className="admin-eyebrow">SNAP AI · Administration</span>
            <h1>Admin Console</h1>
            <p>Manage users, departments, roles and permissions across the company.</p>
          </div>
          <div className="admin-tabs">
            <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
              Users
            </button>
            <button className={tab === "departments" ? "active" : ""} onClick={() => setTab("departments")}>
              Departments
            </button>
            <button className={tab === "roles" ? "active" : ""} onClick={() => setTab("roles")}>
              Roles
            </button>
          </div>
        </div>

        {error && (
          <div className="admin-toast admin-error">
            <span>{error}</span>
            <button className="toast-close" onClick={() => setError("")} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="admin-toast admin-notice">
            <span>{notice}</span>
            <button className="toast-close" onClick={() => setNotice("")} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {loading && <div className="admin-empty">Loading…</div>}

        {/* ── USERS ─────────────────────────────────────────────── */}
        {!loading && tab === "users" && (
          <div className="admin-panel">
            <form className="admin-form" onSubmit={inviteUser}>
              <input
                type="email"
                placeholder="Email to invite"
                value={invite.email}
                onChange={(e) => setInvite({ ...invite, email: e.target.value })}
              />
              <input
                type="text"
                placeholder="Name (optional)"
                value={invite.name}
                onChange={(e) => setInvite({ ...invite, name: e.target.value })}
              />
              <select
                value={invite.role_id}
                onChange={(e) => setInvite({ ...invite, role_id: e.target.value })}
              >
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {roleLabel(r.name)}
                  </option>
                ))}
              </select>
              <select
                value={invite.department_id}
                onChange={(e) => setInvite({ ...invite, department_id: e.target.value })}
              >
                <option value="">— no department —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button type="submit">✉ Invite user</button>
            </form>

            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Department</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const inactive = u.status === "INACTIVE";
                  return (
                    <tr key={u.id} className={inactive ? "inactive" : ""}>
                      <td>{u.name}</td>
                      <td className="muted">{u.email}</td>
                      <td>
                        <select
                          value={u.department_id ?? ""}
                          disabled={inactive}
                          onChange={(e) =>
                            changeUser(u.id, { department_id: e.target.value || null })
                          }
                        >
                          <option value="">— none —</option>
                          {departments.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={u.role_id ?? ""}
                          disabled={inactive || u.id === me?.id}
                          onChange={(e) => changeUser(u.id, { role_id: e.target.value })}
                          title={u.id === me?.id ? "You can't change your own role" : ""}
                        >
                          {roles.map((r) => (
                            <option key={r.id} value={r.id}>
                              {roleLabel(r.name)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {inactive ? (
                          <span className="badge off">Deactivated</span>
                        ) : u.email_verified ? (
                          <span className="badge on">Active</span>
                        ) : (
                          <span className="badge pending">Invited</span>
                        )}
                      </td>
                      <td>
                        {u.id !== me?.id &&
                          (inactive ? (
                            <div className="row-actions">
                              <button className="ghost-btn" onClick={() => reactivate(u)}>
                                Reactivate
                              </button>
                              <button className="danger-btn" onClick={() => removeUser(u)}>
                                Delete
                              </button>
                            </div>
                          ) : (
                            <button className="danger-btn" onClick={() => deactivate(u)}>
                              Deactivate
                            </button>
                          ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {users.length === 0 && <div className="admin-empty">No users.</div>}
          </div>
        )}

        {/* ── DEPARTMENTS ───────────────────────────────────────── */}
        {!loading && tab === "departments" && (
          <div className="admin-panel">
            <form className="admin-form" onSubmit={addDepartment}>
              <input
                placeholder="New department name (e.g. Legal)"
                value={newDept.name}
                onChange={(e) => setNewDept({ ...newDept, name: e.target.value })}
              />
              <input
                placeholder="Description (optional)"
                value={newDept.description}
                onChange={(e) => setNewDept({ ...newDept, description: e.target.value })}
              />
              <button type="submit">＋ Add department</button>
            </form>
            <div className="dept-list">
              {departments.map((d) => {
                const breakdown = deptRoleBreakdown(d.id);
                const count = breakdown.reduce((s, [, c]) => s + c, 0);
                const editing = editDept.id === d.id;
                return (
                  <div className="dept-card" key={d.id}>
                    {editing ? (
                      <div className="dept-edit">
                        <input
                          value={editDept.name}
                          placeholder="Department name"
                          onChange={(e) => setEditDept({ ...editDept, name: e.target.value })}
                        />
                        <input
                          value={editDept.description}
                          placeholder="Description"
                          onChange={(e) => setEditDept({ ...editDept, description: e.target.value })}
                        />
                        <div className="dept-edit-actions">
                          <button className="save-btn" onClick={saveDept}>
                            Save
                          </button>
                          <button className="link-btn" onClick={cancelEditDept}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="dept-card-head">
                          <span className="dept-name">{d.name}</span>
                          <span className="dept-count">
                            {count} active user{count === 1 ? "" : "s"}
                          </span>
                        </div>
                        {d.description && <p className="dept-desc">{d.description}</p>}
                        <div className="dept-roles">
                          <span className="dept-roles-label">Roles:</span>
                          {breakdown.length === 0 ? (
                            <span className="muted">none yet</span>
                          ) : (
                            breakdown.map(([label, c]) => (
                              <span key={label} className="role-pill">
                                {label} · {c}
                              </span>
                            ))
                          )}
                        </div>
                        <div className="dept-card-actions">
                          <button className="ghost-btn" onClick={() => startEditDept(d)}>
                            Edit
                          </button>
                          <button className="danger-btn" onClick={() => removeDepartment(d)}>
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
              {departments.length === 0 && <div className="admin-empty">No departments.</div>}
            </div>
          </div>
        )}

        {/* ── ROLES ─────────────────────────────────────────────── */}
        {!loading && tab === "roles" && (
          <div className="admin-panel roles-panel">
            <h2 className="section-title">Existing roles</h2>
            <div className="role-list">
              {roles.map((r) => (
                <div className="role-card" key={r.id}>
                  <div className="role-card-head">
                    <span className="role-name">{roleLabel(r.name)}</span>
                    <span className={`badge ${r.is_global ? "" : "pending"}`}>
                      {r.is_global ? "Built-in" : "Custom"}
                    </span>
                  </div>
                  {r.description && <p className="role-desc">{r.description}</p>}
                  <div className="role-perms">
                    {r.permissions.length === 0 ? (
                      <span className="muted">No permissions</span>
                    ) : (
                      r.permissions.map((a) => (
                        <span key={a} className="perm-chip" title={a}>
                          {humanizePerm(a)}
                        </span>
                      ))
                    )}
                  </div>
                  <div className="role-card-foot">
                    <span className="role-perm-count">
                      {r.permissions.length} permission{r.permissions.length === 1 ? "" : "s"}
                    </span>
                    {!r.is_global && (
                      <button className="danger-btn role-delete" onClick={() => removeRole(r)}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <h2 className="section-title">Create a new role</h2>
            <form className="role-builder" onSubmit={createRole}>
              <div className="role-builder-fields">
                <label className="field">
                  <span className="field-label">Role name</span>
                  <input
                    type="text"
                    placeholder="e.g. Analyst"
                    value={roleForm.name}
                    onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Description <em>(optional)</em></span>
                  <input
                    type="text"
                    placeholder="What is this role for?"
                    value={roleForm.description}
                    onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })}
                  />
                </label>
              </div>

              <div className="perm-picker">
                <div className="perm-picker-head">
                  <span className="field-label">Permissions</span>
                  <span className="muted">{roleForm.permissions.length} selected</span>
                </div>

                {GROUP_ORDER.filter((g) => groupedPerms[g]).map((g) => {
                  const items = groupedPerms[g];
                  const actions = items.map((p) => p.action);
                  const allOn = actions.every((a) => roleForm.permissions.includes(a));
                  return (
                    <div className="perm-group" key={g}>
                      <div className="perm-group-head">
                        <span className="perm-group-title">{g}</span>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => toggleGroup(actions, !allOn)}
                        >
                          {allOn ? "Clear" : "Select all"}
                        </button>
                      </div>
                      <div className="perm-rows">
                        {items.map((p) => {
                          const on = roleForm.permissions.includes(p.action);
                          return (
                            <button
                              type="button"
                              key={p.action}
                              className={`perm-row ${on ? "on" : ""}`}
                              onClick={() => togglePerm(p.action)}
                            >
                              <span className={`perm-check ${on ? "on" : ""}`}>{on ? "✓" : ""}</span>
                              <span className="perm-text">
                                <span className="perm-title">{humanizePerm(p.action)}</span>
                                <span className="perm-sub">{p.description}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              <button type="submit" className="create-role-btn">＋ Create role</button>
            </form>
          </div>
        )}

        {deptToDelete && (
          <div className="modal-overlay" onClick={() => setDeptToDelete(null)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              <h2>Delete "{deptToDelete.name}"</h2>
              <p className="modal-sub">
                This department has{" "}
                {deptRoleBreakdown(deptToDelete.id).reduce((s, [, c]) => s + c, 0)} active
                user(s). Choose what happens to them.
              </p>

              {departments.filter((x) => x.id !== deptToDelete.id).length > 0 && (
                <label className="modal-opt">
                  <input
                    type="radio"
                    name="deptmode"
                    checked={deptDeleteMode === "reassign"}
                    onChange={() => setDeptDeleteMode("reassign")}
                  />
                  <span>Move them to</span>
                  <select
                    value={deptReassignTarget}
                    disabled={deptDeleteMode !== "reassign"}
                    onChange={(e) => setDeptReassignTarget(e.target.value)}
                  >
                    {departments
                      .filter((x) => x.id !== deptToDelete.id)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}

              <label className="modal-opt">
                <input
                  type="radio"
                  name="deptmode"
                  checked={deptDeleteMode === "deactivate"}
                  onChange={() => setDeptDeleteMode("deactivate")}
                />
                <span>Deactivate all users in this department</span>
              </label>

              <div className="modal-actions">
                <button className="link-btn" onClick={() => setDeptToDelete(null)}>
                  Cancel
                </button>
                <button className="danger-btn" onClick={confirmDeleteDept}>
                  Delete department
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default Admin;
