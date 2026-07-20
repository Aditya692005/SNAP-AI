import { useEffect, useState } from "react";
import { FaFolderOpen } from "react-icons/fa6";
import { MdDashboard } from "react-icons/md";
import { VscEditSparkle } from "react-icons/vsc";
import { HiOutlineDocumentReport } from "react-icons/hi";
import { GrUserAdmin } from "react-icons/gr";
import { IoSettingsSharp, IoNotificationsOutline } from "react-icons/io5";
import { Link, useLocation } from "react-router-dom";
import { authService } from "../services/authService";
import { useUpdates } from "../context/UpdatesContext";
import "./Sidebar.css";
import "./Updates.css";

// A slim icon rail that expands to reveal labels on hover — no click toggle.
// Labels are always in the DOM (hidden by CSS when the rail is collapsed) so the
// expand/collapse is pure CSS, driven by :hover.
function Sidebar() {
  const location = useLocation();
  // Re-read permission-gated items when SessionWatcher refreshes the cached user.
  const [, setUserTick] = useState(0);
  useEffect(() => {
    const bump = () => setUserTick((n) => n + 1);
    window.addEventListener("snap:user-updated", bump);
    return () => window.removeEventListener("snap:user-updated", bump);
  }, []);

  const isAdmin = authService.isAdmin();
  const { unread } = useUpdates();

  const items = [
    { to: "/dashboard", label: "Dashboard", icon: <MdDashboard /> },
    { to: "/documents", label: "Documents", icon: <FaFolderOpen /> },
  ];
  if (authService.canUseAIAssistant())
    items.push({ to: "/ai", label: "AI Assistant", icon: <VscEditSparkle /> });
  items.push({ to: "/reports", label: "Reports", icon: <HiOutlineDocumentReport /> });
  if (isAdmin)
    items.push({ to: "/admin", label: "Admin", icon: <GrUserAdmin /> });
  items.push({ to: "/settings", label: "Settings", icon: <IoSettingsSharp /> });

  return (
    <aside className="sidebar">
      <nav>
        {items.map((it) => (
          <Link
            key={it.to}
            to={it.to}
            className={location.pathname === it.to ? "active" : ""}
            title={it.label}
          >
            {it.icon && <span className="nav-icon">{it.icon}</span>}
            <span className="nav-label">{it.label}</span>
          </Link>
        ))}

        {/* Updates: links to the full notifications page. The red bubble shows
            the unread count and is visible even while the rail is collapsed. */}
        <Link
          to="/updates"
          className={`updates-link ${location.pathname === "/updates" ? "active" : ""}`}
          title="Updates"
        >
          <span className="nav-icon">
            <IoNotificationsOutline />
            {unread > 0 && (
              <span className="updates-badge">{unread > 99 ? "99+" : unread}</span>
            )}
          </span>
          <span className="nav-label">Updates</span>
        </Link>
      </nav>

      <div className="sidebar-footer">
        <p>v1.0</p>
      </div>
    </aside>
  );
}

export default Sidebar;
