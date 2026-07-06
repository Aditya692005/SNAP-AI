import { useState } from "react";
import { FaFolderOpen } from "react-icons/fa6";
import { MdDashboard } from "react-icons/md";
import { VscEditSparkle } from "react-icons/vsc";
import { HiOutlineDocumentReport } from "react-icons/hi";
import { GrUserAdmin } from "react-icons/gr";
import { IoSettingsSharp } from "react-icons/io5";
import { SiSnapcraft } from "react-icons/si";
import { IoIosArrowForward } from "react-icons/io";
import { IoIosArrowBack } from "react-icons/io";
import { Link, useLocation } from "react-router-dom";
import { authService } from "../services/authService";
import "./Sidebar.css";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: <MdDashboard /> },
  { to: "/documents", label: "Documents", icon: <FaFolderOpen /> },
  { to: "/ai", label: "AI Assistant", icon: <VscEditSparkle /> },
  { to: "/reports", label: "Reports", icon: <HiOutlineDocumentReport /> },
];

function Sidebar() {
  const location = useLocation();
  const isAdmin = authService.isAdmin();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "1",
  );

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("sidebarCollapsed", next ? "1" : "0");
      return next;
    });
  }

  const items = [...NAV];
  if (isAdmin)
    items.push({ to: "/admin", label: "Admin", icon: <GrUserAdmin /> });
  items.push({ to: "/settings", label: "Settings", icon: <IoSettingsSharp /> });

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="sidebar-top">
        <div className="sidebar-logo">
          <span className="logo-mark">
            <SiSnapcraft />
          </span>
          {!collapsed && (
            <div className="logo-text">
              <h2>SNAP AI</h2>
            </div>
          )}
        </div>
        <button
          className="sidebar-toggle"
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label="Toggle sidebar"
        >
          {/* {collapsed ? "»" : "«"} */}
          {collapsed ? <IoIosArrowForward /> : <IoIosArrowBack />}
          {/* {collapsed ? ">" : "<"} */}
        </button>
      </div>

      <div className="sidebar-divider"></div>

      <nav>
        {items.map((it) => (
          <Link
            key={it.to}
            to={it.to}
            className={location.pathname === it.to ? "active" : ""}
            title={collapsed ? it.label : undefined}
          >
            {it.icon && <span className="nav-icon">{it.icon}</span>}
            <span className="nav-label">{it.label}</span>
          </Link>
        ))}
      </nav>

      <div className="sidebar-footer">
        <p>{collapsed ? "v1.0" : "SNAP AI v1.0"}</p>
      </div>
    </aside>
  );
}

export default Sidebar;
