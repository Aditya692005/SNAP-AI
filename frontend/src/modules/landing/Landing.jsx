import { useNavigate } from "react-router-dom";
import "./Landing.css";

function Landing() {
  const navigate = useNavigate();

  return (
    <div className="Landing">
      <div className="content">
        <h1>SNAP AI</h1>

        <p className="tagline">
          Transform organizational data into actionable insights using AI-driven
          analytics, knowledge retrieval, and automated reporting
        </p>

        <div className="buttons">
          <button onClick={() => navigate("/signup")} className="signup">
            Sign Up
          </button>

          <button onClick={() => navigate("/login")} className="login">
            Log In
          </button>
        </div>
      </div>
    </div>
  );
}

export default Landing;
