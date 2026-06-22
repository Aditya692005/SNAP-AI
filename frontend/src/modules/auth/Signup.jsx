import { useNavigate } from "react-router-dom";
import "./Signup.css";

function Signup() {
  const navigate = useNavigate();

  return (
    <div className="signup-page">
      <div className="glow glow-1"></div>
      <div className="glow glow-2"></div>

      <div className="signup-card">
        <h1>Create Account</h1>

        <p className="subtitle">
          Join SNAP AI and unlock
          <br />
          intelligent business insights
        </p>

        <form className="signup-form">
          <input type="text" placeholder="Full Name" />

          <input type="email" placeholder="Email Address" />

          <input type="password" placeholder="Password" />

          <select>
            <option value="">Select Role</option>
            <option value="employee">Employee</option>
            <option value="manager">Manager</option>
            <option value="admin">Administrator</option>
          </select>

          <button
            type="submit"
            className="signup-btn"
            onClick={() => navigate("/dashboard")}
          >
            Create Account
          </button>
        </form>

        <p className="login-text">
          Already have an account?
          <span onClick={() => navigate("/login")}> Log In</span>
        </p>
      </div>
    </div>
  );
}

export default Signup;
