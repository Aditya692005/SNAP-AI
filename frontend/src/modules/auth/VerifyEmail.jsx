import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { authService } from "../../services/authService";
import "./VerifyEmail.css";

function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState("verifying"); // verifying, success, error
  const [message, setMessage] = useState("Verifying your email...");
  const [email, setEmail] = useState("");

  useEffect(() => {
    const verifyEmail = async () => {
      try {
        const token = searchParams.get("token");
        if (!token) {
          setStatus("error");
          setMessage("Verification token not found. Please check your link.");
          return;
        }

        const response = await authService.verifyEmail(token);
        setEmail(response.user?.email || "");
        setStatus("success");
        setMessage("Email verified successfully! Redirecting to login...");

        // Signup does not log the user in, so send them to login to sign in.
        setTimeout(() => navigate("/login"), 2000);
      } catch (err) {
        setStatus("error");
        setMessage(err.message || "Failed to verify email. Please try again.");
      }
    };

    verifyEmail();
  }, [searchParams, navigate]);

  return (
    <div className="verify-email-page">
      <div className="verify-email-card">
        <div className={`status-icon ${status}`}>
          {status === "verifying" && <span>⏳</span>}
          {status === "success" && <span>✅</span>}
          {status === "error" && <span>❌</span>}
        </div>

        <h1>
          {status === "verifying" && "Verifying Email"}
          {status === "success" && "Email Verified!"}
          {status === "error" && "Verification Failed"}
        </h1>

        <p className={`message ${status}`}>{message}</p>

        {email && <p className="email-display">Email: {email}</p>}

        {status === "error" && (
          <button className="resend-btn" onClick={() => navigate("/signup")}>
            Back to Signup
          </button>
        )}

        {status === "success" && (
          <p className="redirect-text">Redirecting to login in 2 seconds...</p>
        )}
      </div>
    </div>
  );
}

export default VerifyEmail;
