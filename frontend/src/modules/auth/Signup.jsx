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

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
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

      await authService.signup(
        formData.name,
        formData.email,
        formData.password,
        formData.role
      );

      navigate("/dashboard");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="signup-page">
      <div className="signup-card">
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
        <p className="login-text">
          Already have an account?
          <span onClick={() => navigate("/login")}> Log In</span>
        </p>
      </div>
    </div>
  );
}

export default Signup;
