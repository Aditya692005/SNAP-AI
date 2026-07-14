import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authService } from "../../services/authService";
import { passwordProblems } from "../../utils/password";
import "./Login.css";

function AcceptInvite() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [info, setInfo] = useState(null); // null=loading, {valid,...}
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const reqs = passwordProblems(password);

  useEffect(() => {
    if (!token) {
      setInfo({ valid: false });
      return;
    }
    authService
      .getInviteInfo(token)
      .then((res) => {
        setInfo(res);
        if (res?.valid) setName(res.name || "");
      })
      .catch(() => setInfo({ valid: false }));
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (reqs.length > 0) return setError("Password does not meet requirements");
    if (password !== confirm) return setError("Passwords do not match");

    setLoading(true);
    try {
      await authService.acceptInvite(token, password, name.trim());
      setDone(true);
      setTimeout(() => navigate("/login"), 2000);
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
        {info === null ? (
          <p className="subtitle">Checking your invite…</p>
        ) : !info.valid ? (
          <>
            <h1>Invite Invalid</h1>
            <p className="subtitle">
              This invite link is invalid or has expired. Ask your administrator
              to send a new one.
            </p>
            <button className="login-btn" onClick={() => navigate("/login")}>
              Go to Log In
            </button>
          </>
        ) : done ? (
          <>
            <h1>Welcome aboard!</h1>
            <p className="subtitle">
              Your account is active. Redirecting to login…
            </p>
          </>
        ) : (
          <>
            <h1>Accept Invite</h1>
            <p className="subtitle">
              Set up your account for <strong>{info.email}</strong>.
            </p>
            <form className="login-form" onSubmit={handleSubmit}>
              <input
                type="text"
                placeholder="Your Name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError("");
                }}
                disabled={loading}
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError("");
                }}
                disabled={loading}
              />
              {password && reqs.length > 0 && (
                <ul style={{ textAlign: "left", color: "#f87171", fontSize: "0.85rem", margin: 0, paddingLeft: 18 }}>
                  {reqs.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <input
                type="password"
                placeholder="Confirm Password"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setError("");
                }}
                disabled={loading}
              />
              {error && <p className="error-message">{error}</p>}
              <button type="submit" className="login-btn" disabled={loading}>
                {loading ? "Activating…" : "Activate Account"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

export default AcceptInvite;
