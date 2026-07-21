import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { authService } from "../services/authService";
import { getTheme, toggleTheme } from "../services/theme";
import { initials, roleLabel } from "../utils/user";
import "./UserMenu.css";

const PUBLIC_PATHS = ["/", "/login", "/signup", "/verify-email", "/forgot-password", "/accept-invite"];

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

  // There's no global user store, so Settings announces a profile change and we
  // pick the fresh copy up from the cache — otherwise the avatar and name here
  // would keep showing the old value until this component happened to remount.
  useEffect(() => {
    const onUserUpdated = () => setUser(authService.getUser());
    window.addEventListener("snap:user-updated", onUserUpdated);
    return () => window.removeEventListener("snap:user-updated", onUserUpdated);
  }, []);

  // Hide on public/auth pages and when logged out.
  if (isPublic || !authService.isAuthenticated() || !user) {
    return null;
  }

  // Department is assigned later by an org_admin, so it may be unset at first.
  // Show a placeholder while the name is still loading for an assigned user.
  const deptName = user.department_name || (user.department_id ? "…" : "Unassigned");

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
                <span className="usermenu-val">{roleLabel(user.role)}</span>
              </div>
              <div className="usermenu-row">
                <span className="usermenu-key">Department</span>
                <span className="usermenu-val">{deptName}</span>
              </div>
            </div>

            <div className="usermenu-sep" />

            {/* <button
              className="usermenu-theme"
              onClick={() => {
                setOpen(false);
                navigate("/settings");
              }}
            >
              <span>⚙️ Settings</span>
            </button>

            <button
              className="usermenu-theme"
              onClick={() => {
                setOpen(false);
                navigate("/settings?tab=security");
              }}
            >
              <span>🔑 Change password</span>
            </button>

            <button className="usermenu-theme" onClick={onToggleTheme}>
              <span>{theme === "dark" ? "🌙 Dark mode" : "☀️ Light mode"}</span>
              <span className={`theme-switch ${theme === "light" ? "on" : ""}`} />
            </button> */}

            <button className="usermenu-logout" onClick={onLogout}>
               Log out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default UserMenu;