import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authService } from "../../services/authService";
import "./Login.css";

function passwordProblems(password) {
  const out = [];
  if (password.length < 12) out.push("At least 12 characters");
  if (!/[A-Z]/.test(password)) out.push("One uppercase letter");
  if (!/[a-z]/.test(password)) out.push("One lowercase letter");
  if (!/[0-9]/.test(password)) out.push("One number");
  if (!/[!@#$%^&*_-]/.test(password)) out.push("One special character");
  return out;
}

function ChangePassword() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const reqs = passwordProblems(form.next);

  const onChange = (e) => {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
    setError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (!form.current) return setError("Enter your current password");
    if (reqs.length > 0) return setError("New password does not meet requirements");
    if (form.next !== form.confirm) return setError("New passwords do not match");
    if (form.next === form.current) {
      return setError("New password must be different from your current password");
    }

    setLoading(true);
    try {
      await authService.changePassword(form.current, form.next);
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="glow glow-1"></div>
      <div className="glow glow-2"></div>

      <div className="login-card">
        {done ? (
          <>
            <h1>Password Changed</h1>
            <p className="subtitle">Your password has been updated.</p>
            <button className="login-btn" onClick={() => navigate("/dashboard")}>
              Back to Dashboard
            </button>
          </>
        ) : (
          <>
            <h1>Change Password</h1>
            <p className="subtitle">
              Enter your current password and choose a new one.
            </p>
            <form className="login-form" onSubmit={handleSubmit}>
              <input
                type="password"
                name="current"
                placeholder="Current Password"
                value={form.current}
                onChange={onChange}
                disabled={loading}
              />
              <input
                type="password"
                name="next"
                placeholder="New Password"
                value={form.next}
                onChange={onChange}
                disabled={loading}
              />
              {form.next && reqs.length > 0 && (
                <ul style={{ textAlign: "left", color: "#f87171", fontSize: "0.85rem", margin: 0, paddingLeft: 18 }}>
                  {reqs.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <input
                type="password"
                name="confirm"
                placeholder="Confirm New Password"
                value={form.confirm}
                onChange={onChange}
                disabled={loading}
              />
              {error && <p className="error-message">{error}</p>}
              <button type="submit" className="login-btn" disabled={loading}>
                {loading ? "Updating..." : "Change Password"}
              </button>
            </form>
          </>
        )}
        {!done && (
          <p className="signup-text">
            <span onClick={() => navigate("/dashboard")}>Back to Dashboard</span>
          </p>
        )}
      </div>
    </div>
  );
}

export default ChangePassword;
