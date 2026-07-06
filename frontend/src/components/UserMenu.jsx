import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { authService } from "../services/authService";
import { getTheme, toggleTheme } from "../services/theme";
import "./UserMenu.css";

const PUBLIC_PATHS = ["/", "/login", "/signup", "/verify-email", "/forgot-password", "/accept-invite"];

const ROLE_LABELS = {
  employee: "Employee",
  manager: "Manager",
  org_admin: "Company Admin",
  admin: "Administrator",
};

function initials(name, email) {
  const base = (name || email || "?").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

function UserMenu() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(getTheme());
  const [user, setUser] = useState(authService.getUser());

  const isPublic = PUBLIC_PATHS.includes(location.pathname);

  // Re-sync the cached user from the server on mount so a department/role change
  // made by an admin shows up (name + gating) without waiting for a re-login.
  useEffect(() => {
    if (isPublic || !authService.isAuthenticated()) return;
    let alive = true;
    authService.refreshUser().then((fresh) => {
      if (alive && fresh) setUser(fresh);
    });
    return () => {
      alive = false;
    };
  }, [isPublic]);

  // Hide on public/auth pages and when logged out.
  if (isPublic || !authService.isAuthenticated() || !user) {
    return null;
  }

  // Department is assigned later by an org_admin, so it may be unset at first.
  // Show a placeholder while the name is still loading for an assigned user.
  const deptName = user.department_name || (user.department_id ? "…" : "Unassigned");
  const roleLabel = ROLE_LABELS[user.role] || user.role || "—";

  function onToggleTheme() {
    setTheme(toggleTheme());
  }

  function onLogout() {
    authService.logout();
    navigate("/login");
  }

  return (
    <div className="usermenu">
      <button
        className="usermenu-avatar"
        onClick={() => setOpen((o) => !o)}
        title={user.name || user.email}
        aria-label="Account menu"
      >
        {initials(user.name, user.email)}
      </button>

      {open && (
        <>
          <div className="usermenu-backdrop" onClick={() => setOpen(false)} />
          <div className="usermenu-panel">
            <div className="usermenu-id">
              <div className="usermenu-avatar lg">{initials(user.name, user.email)}</div>
              <div className="usermenu-id-text">
                <span className="usermenu-name">{user.name || "—"}</span>
                <span className="usermenu-email">{user.email}</span>
              </div>
            </div>

            <div className="usermenu-rows">
              <div className="usermenu-row">
                <span className="usermenu-key">Role</span>
                <span className="usermenu-val">{roleLabel}</span>
              </div>
              <div className="usermenu-row">
                <span className="usermenu-key">Department</span>
                <span className="usermenu-val">{deptName}</span>
              </div>
            </div>

            <div className="usermenu-sep" />

            <button
              className="usermenu-theme"
              onClick={() => {
                setOpen(false);
                navigate("/change-password");
              }}
            >
              <span>🔑 Change password</span>
            </button>

            <button className="usermenu-theme" onClick={onToggleTheme}>
              <span>{theme === "dark" ? "🌙 Dark mode" : "☀️ Light mode"}</span>
              <span className={`theme-switch ${theme === "light" ? "on" : ""}`} />
            </button>

            <button className="usermenu-logout" onClick={onLogout}>
              ⎋ Log out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default UserMenu;
