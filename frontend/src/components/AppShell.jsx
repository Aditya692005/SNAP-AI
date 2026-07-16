import { useEffect, useState } from "react";
import Sidebar from "./Sidebar";
import { organizationService } from "../services/authService";
import "./AppShell.css";

// Org name is the same on every page — fetch it once per app load, not per mount.
let cachedOrgName = null;

// Shared chrome for every signed-in page: a full-width top bar
// (Company Name · SNAP AI · page actions) sitting ABOVE the sidebar + content
// row, so it spans the whole window and never shrinks when the hover rail
// expands. Pages pass their own header buttons via `actions`, and can add a
// page class via `className` (e.g. the chat page pins the shell to 100vh).
function AppShell({ actions = null, className = "", children }) {
  const [orgName, setOrgName] = useState(cachedOrgName);

  useEffect(() => {
    if (cachedOrgName) return;
    organizationService
      .get()
      .then((o) => {
        cachedOrgName = o?.name || null;
        setOrgName(cachedOrgName);
      })
      .catch(() => {});
  }, []);

  return (
    <div className={`app-page ${className}`.trim()}>
      <div className="app-topbar">
        <span className="topbar-company">{orgName || "Company"}</span>
        <span className="topbar-brand">SNAP AI</span>
        <div className="topbar-actions">{actions}</div>
      </div>

      <div className="app-shell">
        <Sidebar />
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}

export default AppShell;
