import { useEffect, useMemo, useState } from "react";
import Sidebar from "../../components/Sidebar";
import { adminService, authService } from "../../services/authService";
import "./Admin.css";

const ROLES = ["employee", "manager", "org_admin"];
const ROLE_LABELS = { employee: "Employee", manager: "Manager", org_admin: "Company Admin" };

function Admin() {
  const me = authService.getUser();
  const [tab, setTab] = useState("users");
  const [users, setUsers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newDept, setNewDept] = useState("");

  const deptById = useMemo(
    () => Object.fromEntries(departments.map((d) => [d.id, d])),
    [departments]
  );

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [u, d] = await Promise.all([
        adminService.listUsers(),
        adminService.listDepartments(),
      ]);
      setUsers(u);
      setDepartments(d);
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
      setUsers((prev) =>
        prev.map((x) => (x.id === u.id ? { ...x, deactivated_at: new Date().toISOString() } : x))
      );
    } catch (err) {
      setError(err.message);
    }
  }

  async function addDepartment(e) {
    e.preventDefault();
    const name = newDept.trim();
    if (!name) return;
    try {
      const { department } = await adminService.createDepartment(name);
      setDepartments((prev) => [...prev, department].sort((a, b) => a.name.localeCompare(b.name)));
      setNewDept("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeDepartment(d) {
    if (!window.confirm(`Delete department "${d.name}"?`)) return;
    try {
      await adminService.deleteDepartment(d.id);
      setDepartments((prev) => prev.filter((x) => x.id !== d.id));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="admin">
      <Sidebar />
      <main className="admin-content">
        <div className="admin-header">
          <div>
            <span className="admin-eyebrow">SNAP AI · Administration</span>
            <h1>Admin Console</h1>
            <p>Manage departments, users, and roles across the company.</p>
          </div>
          <div className="admin-tabs">
            <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
              Users
            </button>
            <button className={tab === "departments" ? "active" : ""} onClick={() => setTab("departments")}>
              Departments
            </button>
          </div>
        </div>

        {error && <div className="admin-error">{error}</div>}
        {loading && <div className="admin-empty">Loading…</div>}

        {!loading && tab === "users" && (
          <div className="admin-panel">
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
                  const inactive = !!u.deactivated_at;
                  return (
                    <tr key={u.id} className={inactive ? "inactive" : ""}>
                      <td>{u.name}</td>
                      <td className="muted">{u.email}</td>
                      <td>
                        <select
                          value={u.department_id ?? ""}
                          disabled={inactive}
                          onChange={(e) =>
                            changeUser(u.id, { department_id: Number(e.target.value) })
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
                          value={u.role}
                          disabled={inactive || u.id === me?.id}
                          onChange={(e) => changeUser(u.id, { role: e.target.value })}
                          title={u.id === me?.id ? "You can't change your own role" : ""}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
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
                          <span className="badge pending">Unverified</span>
                        )}
                      </td>
                      <td>
                        {!inactive && u.id !== me?.id && (
                          <button className="danger-btn" onClick={() => deactivate(u)}>
                            Deactivate
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {users.length === 0 && <div className="admin-empty">No users.</div>}
          </div>
        )}

        {!loading && tab === "departments" && (
          <div className="admin-panel">
            <form className="dept-add" onSubmit={addDepartment}>
              <input
                placeholder="New department name (e.g. Legal)"
                value={newDept}
                onChange={(e) => setNewDept(e.target.value)}
              />
              <button type="submit">＋ Add department</button>
            </form>
            <div className="dept-list">
              {departments.map((d) => {
                const count = users.filter(
                  (u) => u.department_id === d.id && !u.deactivated_at
                ).length;
                return (
                  <div className="dept-row" key={d.id}>
                    <div className="dept-info">
                      <span className="dept-name">{d.name}</span>
                      <span className="dept-key">{d.key}</span>
                      <span className="dept-count">{count} active user{count === 1 ? "" : "s"}</span>
                    </div>
                    <button className="danger-btn" onClick={() => removeDepartment(d)}>
                      Delete
                    </button>
                  </div>
                );
              })}
              {departments.length === 0 && <div className="admin-empty">No departments.</div>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default Admin;
