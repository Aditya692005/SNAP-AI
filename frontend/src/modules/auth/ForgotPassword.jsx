import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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

function ForgotPassword() {
  const navigate = useNavigate();
  const location = useLocation();
  // Email the user already typed on the login page, if any.
  const prefilledEmail = location.state?.email || "";

  const [step, setStep] = useState("email"); // email | otp | done
  const [email, setEmail] = useState(prefilledEmail);
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const autoSent = useRef(false);

  const reqs = passwordProblems(password);

  // Step 1: request an OTP (only sent if the account exists).
  const sendOtpTo = async (addr) => {
    setError("");
    setLoading(true);
    try {
      if (!addr) throw new Error("Please enter your email");
      await authService.forgotPassword(addr); // throws if no account
      setStep("otp");
    } catch (err) {
      setError(err.message); // e.g. "No account found for that email address."
    } finally {
      setLoading(false);
    }
  };

  const requestOtp = (e) => {
    e.preventDefault();
    sendOtpTo(email);
  };

  // If we arrived with an email already typed on login, send the OTP straight
  // away so the user doesn't have to retype it.
  useEffect(() => {
    if (prefilledEmail && !autoSent.current) {
      autoSent.current = true;
      sendOtpTo(prefilledEmail);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefilledEmail]);

  // Step 2: submit OTP + new password.
  const submitReset = async (e) => {
    e.preventDefault();
    setError("");
    if (!otp.trim()) return setError("Enter the OTP from your email");
    if (reqs.length > 0) return setError("Password does not meet requirements");
    if (password !== confirm) return setError("Passwords do not match");

    setLoading(true);
    try {
      await authService.resetPassword(email, otp.trim(), password);
      setStep("done");
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
        {step === "email" && (
          <>
            <h1>Forgot Password</h1>
            <p className="subtitle">
              Enter your email and we'll send you a one-time password (OTP).
            </p>
            <form className="login-form" onSubmit={requestOtp}>
              <input
                type="email"
                placeholder="Email Address"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError("");
                }}
                disabled={loading}
              />
              {error && <p className="error-message">{error}</p>}
              <button type="submit" className="login-btn" disabled={loading}>
                {loading ? "Sending..." : "Send OTP"}
              </button>
            </form>
          </>
        )}

        {step === "otp" && (
          <>
            <h1>Enter OTP</h1>
            <p className="subtitle">
              We've sent a 6-digit code to <strong>{email}</strong>. It expires in
              10 minutes.
            </p>
            <form className="login-form" onSubmit={submitReset}>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="6-digit OTP"
                value={otp}
                onChange={(e) => {
                  setOtp(e.target.value.replace(/\D/g, ""));
                  setError("");
                }}
                disabled={loading}
              />
              <input
                type="password"
                placeholder="New Password"
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
                placeholder="Confirm New Password"
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setError("");
                }}
                disabled={loading}
              />
              {error && <p className="error-message">{error}</p>}
              <button type="submit" className="login-btn" disabled={loading}>
                {loading ? "Resetting..." : "Reset Password"}
              </button>
            </form>
            <p className="signup-text">
              Didn't get it?{" "}
              <span onClick={() => setStep("email")}>Try a different email</span>
            </p>
          </>
        )}

        {step === "done" && (
          <>
            <h1>Password Reset</h1>
            <p className="subtitle">
              Your password has been updated. Redirecting to login...
            </p>
          </>
        )}

        {step !== "done" && (
          <p className="signup-text">
            Remembered it?
            <span onClick={() => navigate("/login")}> Log In</span>
          </p>
        )}
      </div>
    </div>
  );
}

export default ForgotPassword;
