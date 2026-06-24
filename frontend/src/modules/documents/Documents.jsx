import Sidebar from "../../components/Sidebar";
import "./Documents.css";

function Documents() {
  return (
    <div className="documents-layout">
      <Sidebar />

      <main className="documents-content">
        <div className="documents-header">
          <h1>Documents</h1>

          <p>Upload and manage documents assigned to your role.</p>
        </div>

        <div className="documents-section">
          <div className="section-header">
            <h2>Required Documents</h2>

            <span>1 of 4 uploaded</span>
          </div>

          <div className="documents-list">
            <div className="document-row">
              <div className="document-info">
                <h3>Monthly Sales Data</h3>

                <p>Upload monthly sales records for analytics and reporting.</p>
              </div>

              <div className="document-actions">
                <span className="status pending">Not Uploaded</span>

                <button className="upload-button">Upload</button>
              </div>
            </div>

            <div className="document-row">
              <div className="document-info">
                <h3>Expense Report</h3>

                <p>Upload department expense reports.</p>
              </div>

              <div className="document-actions">
                <span className="status pending">Not Uploaded</span>

                <button className="upload-button">Upload</button>
              </div>
            </div>

            <div className="document-row">
              <div className="document-info">
                <h3>Customer Dataset</h3>

                <p>Upload customer information dataset.</p>
              </div>

              <div className="document-actions">
                <span className="status uploaded">Uploaded</span>

                <button className="replace-btn">Replace</button>
              </div>
            </div>

            <div className="document-row">
              <div className="document-info">
                <h3>Project Report</h3>

                <p>Upload latest project performance report.</p>
              </div>

              <div className="document-actions">
                <span className="status pending">Not Uploaded</span>

                <button className="upload-button">Upload</button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default Documents;
