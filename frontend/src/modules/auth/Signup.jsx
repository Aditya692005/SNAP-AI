import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authService } from "../../services/authService";
import "./Signup.css";

function Signup() {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    password: "",
    role: "employee",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [passwordRequirements, setPasswordRequirements] = useState([]);
  const [success, setSuccess] = useState(false);
  const [successEmail, setSuccessEmail] = useState("");

  const validatePasswordStrength = (password) => {
    const requirements = [];
    if (password.length < 12) requirements.push("At least 12 characters");
    if (!/[A-Z]/.test(password)) requirements.push("One uppercase letter");
    if (!/[a-z]/.test(password)) requirements.push("One lowercase letter");
    if (!/[0-9]/.test(password)) requirements.push("One number");
    if (!/[!@#$%^&*_-]/.test(password)) requirements.push("One special character");
    return requirements;
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
    
    // Show password requirements as user types
    if (name === "password") {
      setPasswordRequirements(validatePasswordStrength(value));
    }
    
    setError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (!formData.name || !formData.email || !formData.password || !formData.role) {
        throw new Error("Please fill in all fields");
      }

      if (passwordRequirements.length > 0) {
        throw new Error("Password does not meet requirements");
      }

      const result = await authService.signup(
        formData.name,
        formData.email,
        formData.password,
        formData.role
      );

      setSuccess(true);
      setSuccessEmail(formData.email);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="signup-page">
      <div className="glow glow-1"></div>
      <div className="glow glow-2"></div>

      <div className="signup-card">
        {success ? (
          <>
            <div className="success-icon">✅</div>
            <h1>Check Your Email</h1>
            <p className="subtitle">We've sent a verification link to</p>
            <p className="email-highlight">{successEmail}</p>
            <p className="instruction">
              Click the link in the email to verify your account. <br />
              The link expires in 24 hours.
            </p>
            <p className="secondary-text">
              Didn't receive the email?{" "}
              <span
                onClick={() => {
                  setSuccess(false);
                  setFormData({ name: "", email: "", password: "", role: "employee" });
                  setPasswordRequirements([]);
                }}
                style={{ cursor: "pointer", color: "#ec4899" }}
              >
                Try again
              </span>
            </p>
          </>
        ) : (
          <>
            <h1>Create Account</h1>

            <p className="subtitle">
              Join SNAP AI and unlock <br /> intelligent business insights
            </p>

            <form className="signup-form" onSubmit={handleSubmit}>
              <input
                type="text"
                name="name"
                placeholder="Full Name"
                value={formData.name}
                onChange={handleChange}
                disabled={loading}
              />
              <input
                type="email"
                name="email"
                placeholder="Email Address"
                value={formData.email}
                onChange={handleChange}
                disabled={loading}
              />
              <input
                type="password"
                name="password"
                placeholder="Password"
                value={formData.password}
                onChange={handleChange}
                disabled={loading}
              />
              {formData.password && (
                <div className="password-requirements">
                  {passwordRequirements.length === 0 ? (
                    <p className="requirement-valid">✅ Password meets all requirements</p>
                  ) : (
                    <>
                      <p className="requirement-label">Password must have:</p>
                      <ul className="requirement-list">
                        {passwordRequirements.map((req, idx) => (
                          <li key={idx} className="requirement-item">❌ {req}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
              <select
                name="role"
                value={formData.role}
                onChange={handleChange}
                disabled={loading}
              >
                <option value="employee">Employee</option>
                <option value="manager">Manager</option>
                <option value="admin">Administrator</option>
              </select>
              {error && <p className="error-message">{error}</p>}
              <button
                type="submit"
                className="signup-btn"
                disabled={loading}
              >
                {loading ? "Creating Account..." : "Create Account"}
              </button>
            </form>
          </>
        )}
        <p className="login-text">
          Already have an account?
          <span onClick={() => navigate("/login")}> Log In</span>
        </p>
      </div>
    </div>
  );
}

export default Signup;
