import AppShell from "./AppShell";
import "./PlaceholderPage.css";

function PlaceholderPage({ title, description }) {
  return (
    <AppShell>
      <div className="placeholder-header">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>

      <div className="placeholder-card">
        <h2>Coming soon</h2>
        <p>This section is not available yet. Check back later.</p>
      </div>
    </AppShell>
  );
}

export default PlaceholderPage;
