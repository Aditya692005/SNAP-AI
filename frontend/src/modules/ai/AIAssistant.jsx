import Sidebar from "../../components/Sidebar";
import "./AIAssistant.css";

function AIAssistant() {
  return (
    <div className="ai-layout">
      <Sidebar />

      <main className="ai-content">
        <div className="ai-center">
          <h1>SNAP AI Assistant</h1>

          <p>
            Ask questions about your organization's documents, reports,
            contracts, and datasets.
          </p>

          {/* <div className="suggestions">
            <button>Summarize uploaded documents</button>

            <button>Generate monthly report</button>

            <button>Analyze sales dataset</button>

            <button>Show pending contracts</button>
          </div> */}
        </div>

        <div className="chat-input-container">
          <div className="chat-input">
            <input
              type="text"
              placeholder="Ask anything about your organization..."
            />

            <button>Send</button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default AIAssistant;
