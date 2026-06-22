import { useNavigate } from "react-router-dom";
import "./Login.css";

function Login() {
  const navigate = useNavigate();

  return (
    <div className="login-page">
      <div className="glow glow-1"></div>
      <div className="glow glow-2"></div>

      <div className="login-card">
        <h1>Welcome Back</h1>

        <p className="subtitle">Sign in to access your SNAP AI workspace</p>

        <form className="login-form">
          <input type="email" placeholder="Email Address" />

          <input type="password" placeholder="Password" />

          <button
            type="submit"
            className="login-btn"
            onClick={() => navigate("/dashboard")}
          >
            Log In
          </button>
        </form>

        <p className="signup-text">
          Don't have an account?
          <span onClick={() => navigate("/signup")}> Sign Up</span>
        </p>
      </div>
    </div>
  );
}

export default Login;
