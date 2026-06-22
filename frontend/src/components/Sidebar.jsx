import { Link, useLocation } from "react-router-dom";
import "./Sidebar.css";

function Sidebar() {
  const location = useLocation();

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <h2>SNAP AI</h2>

        <p>Enterprise AI Platform</p>
      </div>

      <div className="sidebar-divider"></div>

      <nav>
        <Link
          to="/dashboard"
          className={location.pathname === "/dashboard" ? "active" : ""}
        >
          Dashboard
        </Link>

        <Link
          to="/documents"
          className={location.pathname === "/documents" ? "active" : ""}
        >
          Documents
        </Link>

        <Link to="/ai" className={location.pathname === "/ai" ? "active" : ""}>
          AI Assistant
        </Link>

        <Link
          to="/reports"
          className={location.pathname === "/reports" ? "active" : ""}
        >
          Reports
        </Link>

        <Link
          to="/users"
          className={location.pathname === "/users" ? "active" : ""}
        >
          Users
        </Link>

        <Link
          to="/settings"
          className={location.pathname === "/settings" ? "active" : ""}
        >
          Settings
        </Link>
      </nav>

      <div className="sidebar-footer">
        <p>SNAP AI v1.0</p>
      </div>
    </aside>
  );
}

export default Sidebar;
