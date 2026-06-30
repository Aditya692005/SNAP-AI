import Sidebar from "./Sidebar";
import "./PlaceholderPage.css";

function PlaceholderPage({ title, description }) {
  return (
    <div className="placeholder-layout">
      <Sidebar />

      <main className="placeholder-content">
        <div className="placeholder-header">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>

        <div className="placeholder-card">
          <h2>Coming soon</h2>
          <p>This section is not available yet. Check back later.</p>
        </div>
      </main>
    </div>
  );
}

export default PlaceholderPage;
