import { Link } from "react-router-dom";
import "./Sidebar.css";

function Sidebar() {
  return (
    <aside className="sidebar">
      <h2>SNAP AI</h2>

      <nav>
        <Link to="/dashboard">Dashboard</Link>

        <Link to="/documents">Documents</Link>

        <Link to="/ai">AI Assistant</Link>

        <Link to="/reports">Reports</Link>

        <Link to="/users">Users</Link>

        <Link to="/settings">Settings</Link>
      </nav>
    </aside>
  );
}

export default Sidebar;
