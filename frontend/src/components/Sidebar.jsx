import { useEffect, useState } from "react";
import { FaFolderOpen } from "react-icons/fa6";
import { MdDashboard } from "react-icons/md";
import { VscEditSparkle } from "react-icons/vsc";
import { HiOutlineDocumentReport } from "react-icons/hi";
import { GrUserAdmin } from "react-icons/gr";
import { IoSettingsSharp } from "react-icons/io5";
import { Link, useLocation } from "react-router-dom";
import { authService } from "../services/authService";
import "./Sidebar.css";

// A slim icon rail that expands to reveal labels on hover — no click toggle.
// Labels are always in the DOM (hidden by CSS when the rail is collapsed) so the
// expand/collapse is pure CSS, driven by :hover.
function Sidebar() {
  const location = useLocation();
  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window === "undefined") return false;
    return Boolean(window.__snapSidebarForceOpen);
  });
  // Re-read permission-gated items when SessionWatcher refreshes the cached user.
  const [, setUserTick] = useState(0);
  useEffect(() => {
    const bump = () => setUserTick((n) => n + 1);
    window.addEventListener("snap:user-updated", bump);

    const syncExpanded = () =>
      setIsExpanded(Boolean(window.__snapSidebarForceOpen));
    window.addEventListener("snap:sidebar-force-open", syncExpanded);

    return () => {
      window.removeEventListener("snap:user-updated", bump);
      window.removeEventListener("snap:sidebar-force-open", syncExpanded);
    };
  }, []);

  const isAdmin = authService.isAdmin();

  const items = [
    { to: "/dashboard", label: "Dashboard", icon: <MdDashboard /> },
    { to: "/documents", label: "Documents", icon: <FaFolderOpen /> },
  ];
  if (authService.canUseAIAssistant())
    items.push({ to: "/ai", label: "AI Assistant", icon: <VscEditSparkle /> });
  items.push({
    to: "/reports",
    label: "Reports",
    icon: <HiOutlineDocumentReport />,
  });
  if (isAdmin)
    items.push({ to: "/admin", label: "Admin", icon: <GrUserAdmin /> });
  items.push({ to: "/settings", label: "Settings", icon: <IoSettingsSharp /> });

  const handleNavClick = () => {
    if (typeof window === "undefined") return;

    window.__snapSidebarForceOpen = true;
    window.dispatchEvent(new Event("snap:sidebar-force-open"));

    if (window.__snapSidebarForceTimer) {
      window.clearTimeout(window.__snapSidebarForceTimer);
    }

    window.__snapSidebarForceTimer = window.setTimeout(() => {
      window.__snapSidebarForceOpen = false;
      window.dispatchEvent(new Event("snap:sidebar-force-open"));
    }, 900);
  };

  return (
    <aside className={`sidebar ${isExpanded ? "expanded" : ""}`.trim()}>
      <nav>
        {items.map((it) => (
          <Link
            key={it.to}
            to={it.to}
            className={location.pathname === it.to ? "active" : ""}
            title={it.label}
            onClick={handleNavClick}
          >
            {it.icon && <span className="nav-icon">{it.icon}</span>}
            <span className="nav-label">{it.label}</span>
          </Link>
        ))}
      </nav>

      <div className="sidebar-footer">
        <p>v1.0</p>
      </div>
    </aside>
  );
}

export default Sidebar;
