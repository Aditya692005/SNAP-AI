import Sidebar from "../../components/Sidebar";
import "./Dashboard.css";

function Dashboard() {
  return (
    <div className="dashboard">
      <Sidebar />

      <main className="dashboard-content">
        <div className="dashboard-header">
          <h1>Dashboard</h1>

          <p>
            Welcome to SNAP AI. Upload documents and datasets to build your
            organization's knowledge base.
          </p>
        </div>

        <div className="welcome-card">
          <h2>Get Started</h2>

          <p>
            Upload PDFs, reports, invoices, contracts, CSV files, and Excel
            sheets to enable AI-powered search, analytics, and reporting.
          </p>

          <button className="upload-btn">Upload Documents</button>
        </div>

        <div className="dashboard-grid">
          <div className="dashboard-card">
            <h2>Knowledge Base</h2>

            <div className="empty-state">No documents available.</div>
          </div>

          <div className="dashboard-card">
            <h2>Recent Uploads</h2>

            <div className="empty-state">No files uploaded yet.</div>
          </div>

          <div className="dashboard-card">
            <h2>Recent AI Activity</h2>

            <div className="empty-state">No AI queries yet.</div>
          </div>

          <div className="dashboard-card">
            <h2>Reports</h2>

            <div className="empty-state">No reports generated.</div>
          </div>
        </div>

        <div className="dashboard-chat">
          <input type="text" placeholder="Ask SNAP AI..." />

          <button>Send</button>
        </div>
      </main>
    </div>
  );
}

export default Dashboard;
