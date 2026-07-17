import { useNavigate } from "react-router-dom";
import "./Landing.css";

function Landing() {
  const navigate = useNavigate();

  return (
    <div className="Landing">
      <div className="content">
        <p className="landing-eyebrow">Enterprise AI Operations Platform</p>

        <h1>SNAP AI</h1>

        <p className="tagline">
          Transform organizational data into actionable insights using AI-driven
          analytics, knowledge retrieval, intelligent search, and automated
          reporting.
        </p>

        <div className="buttons">
          <button className="signup" onClick={() => navigate("/signup")}>
            Get Started
          </button>

          <button className="login" onClick={() => navigate("/login")}>
            Log In
          </button>
        </div>
      </div>
    </div>
  );
}

export default Landing;
