import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authService } from "../../services/authService";
import { passwordProblems } from "../../utils/password";
import "./Signup.css";

function Signup() {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    password: "",
  });
  // Organization details — only used/collected when the email domain is new.
  const [org, setOrg] = useState({
    name: "",
    bio: "",
    industry: "",
    country: "",
    subscriptionPlan: "FREE",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [passwordRequirements, setPasswordRequirements] = useState([]);
  const [success, setSuccess] = useState(false);
  const [successEmail, setSuccessEmail] = useState("");
  const [step, setStep] = useState(1);
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState("");

  const validatePasswordStrength = (password) => {
    const requirements = [];
    if (password.length < 12) requirements.push("At least 12 characters");
    if (!/[A-Z]/.test(password)) requirements.push("One uppercase letter");
    if (!/[a-z]/.test(password)) requirements.push("One lowercase letter");
    if (!/[0-9]/.test(password)) requirements.push("One number");
    if (!/[!@#$%^&*_-]/.test(password))
      requirements.push("One special character");
    return requirements;
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (name === "password")
      setPasswordRequirements(validatePasswordStrength(value));
    setError("");
  };

  const handleOrgChange = (e) => {
    const { name, value } = e.target;
    setOrg((prev) => ({ ...prev, [name]: value }));
    setError("");
  };

  // Suggest an organization name from the email domain (skips free providers,
  // whose domain says nothing about a company). Local-only — signup no longer
  // asks the server whether a domain already has an org, because a matching
  // domain must not auto-join anyone to it.
  const suggestOrgName = (email) => {
    const domain = (email.split("@")[1] || "").toLowerCase();
    if (!domain) return "";
    const free = [
      "gmail.com",
      "yahoo.com",
      "outlook.com",
      "hotmail.com",
      "icloud.com",
      "aol.com",
      "proton.me",
      "protonmail.com",
    ];
    if (free.includes(domain)) return "";
    const base = domain.split(".")[0];
    return base ? base.charAt(0).toUpperCase() + base.slice(1) : "";
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      // Step 1: check email + password, then advance to step 2
      if (step === 1) {
        if (!formData.email || !formData.password) {
          throw new Error("Please fill in all fields");
        }
        if (passwordRequirements.length > 0) {
          throw new Error("Password does not meet requirements");
        }

        const exists = await authService.checkEmailExists(formData.email);
        if (exists) {
          throw new Error("Account already exists");
        }

        // Advance to org setup and suggest an org name from the email domain.
        setOrg((prev) => ({
          ...prev,
          name: prev.name || suggestOrgName(formData.email),
        }));
        setStep(2);
        setLoading(false);
        return;
      }

      // Step 2: create the account and its organization. Every signup creates
      // its OWN org (the signer becomes its admin) — joining an existing org is
      // invite-only, so there's no "join by email domain" path here anymore.
      if (!formData.name || !formData.email || !formData.password) {
        throw new Error("Please fill in all fields");
      }
      if (!org.name.trim()) throw new Error("Organization name is required");
      if (!org.bio.trim())
        throw new Error("Please add a short bio for your organization");
      if (!org.country.trim()) throw new Error("Please select your country");

      const orgPayload = {
        name: org.name.trim(),
        bio: org.bio.trim(),
        industry: org.industry.trim(),
        country: org.country.trim(),
        subscriptionPlan: org.subscriptionPlan,
      };

      await authService.signup(
        formData.name,
        formData.email,
        formData.password,
        orgPayload,
      );

      setSuccess(true);
      setSuccessEmail(formData.email);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Resend the verification email without leaving the success screen. The
  // sanctioned resend path is "log in again": for an unverified account the
  // backend issues a fresh link and rejects the login (403), so we treat that
  // rejection as the confirmation. If the account got verified in the meantime,
  // the login succeeds and we send the user straight to their dashboard.
  const handleResend = async () => {
    if (resending) return;
    setResending(true);
    setResendMsg("");
    try {
      await authService.login(successEmail, formData.password);
      navigate("/dashboard"); // already verified — just log them in
    } catch (err) {
      setResendMsg(
        err.message ||
          "We've sent a new verification link — it expires in 10 minutes.",
      );
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="signup-page">
      {/* <div className="glow"></div> */}

      <div className="signup-card">
        {success ? (
          <>
            <p className="brand">SNAP AI</p>
            <h1>Check Your Email</h1>
            <p className="signup-subtitle">We've sent a verification link to</p>
            <p className="email-highlight">{successEmail}</p>
            <p className="instruction">
              Click the link in the email to verify your account. <br />
              The link expires in 10 minutes, if it does, just log in again to
              get a new one.
            </p>
            <p className="secondary-text">
              Didn't receive the email?{" "}
              <span
                onClick={handleResend}
                style={{
                  cursor: resending ? "default" : "pointer",
                  color: "#ffffff",
                  fontWeight: 600,
                  opacity: resending ? 0.6 : 1,
                }}
              >
                {resending ? "Sending…" : "Resend email"}
              </span>
            </p>
            {resendMsg && <p className="instruction">{resendMsg}</p>}
          </>
        ) : (
          <>
            <p className="brand">SNAP AI</p>
            {step === 2 ? <h1>Setup Organization</h1> : <h1>Create Account</h1>}

            {step === 2 ? (
              <p className="signup-subtitle">
                Set up your organization — you'll be its admin. To join an
                existing organization instead, ask its admin to invite you.
              </p>
            ) : (
              <p className="signup-subtitle">
                Unlock Intelligent Business Insights
              </p>
            )}
            {/* <p className="steps">Step {step} of 2</p> */}
            <form className="signup-form" onSubmit={handleSubmit}>
              {step === 1 && (
                <>
                  <input
                    type="email"
                    name="email"
                    placeholder="Email Address"
                    value={formData.email}
                    onChange={handleChange}
                    disabled={loading}
                  />
                  <div className="input-with-toggle">
                    <input
                      type={showPassword ? "text" : "password"}
                      name="password"
                      placeholder="Password"
                      value={formData.password}
                      onChange={handleChange}
                      disabled={loading}
                    />
                    <button
                      type="button"
                      className="show-password-toggle"
                      onClick={() => setShowPassword((s) => !s)}
                      aria-pressed={showPassword}
                      aria-label={
                        showPassword ? "Hide password" : "Show password"
                      }
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </div>
                </>
              )}
              {step === 2 && (
                <>
                  {/* {isNewOrg && ( */}
                    <div className="org-setup">
                      {/* <p className="org-setup-title">
                        Set up your organization
                      </p>
                      <p className="field-hint">
                        You're the first person from this domain, so you'll be
                        the organization admin.
                      </p> */}
                      <input
                        type="text"
                        name="name"
                        placeholder="Full Name"
                        value={formData.name}
                        onChange={handleChange}
                        disabled={loading}
                      />
                      <input
                        type="text"
                        name="name"
                        placeholder="Organization name"
                        value={org.name}
                        onChange={handleOrgChange}
                        disabled={loading}
                      />
                      <textarea
                        name="bio"
                        placeholder="Organization bio"
                        value={org.bio}
                        onChange={handleOrgChange}
                        disabled={loading}
                        rows={2}
                      />
                      <input
                        type="text"
                        name="industry"
                        placeholder="Industry (optional)"
                        value={org.industry}
                        onChange={handleOrgChange}
                        disabled={loading}
                      />
                      <select
                        name="country"
                        value={org.country}
                        onChange={handleOrgChange}
                        disabled={loading}
                      >
                        <option value="">Select a country</option>
                        <option value="United States">United States</option>
                        <option value="Canada">Canada</option>
                        <option value="United Kingdom">United Kingdom</option>
                        <option value="Australia">Australia</option>
                        <option value="India">India</option>
                        <option value="Germany">Germany</option>
                        <option value="France">France</option>
                        <option value="Brazil">Brazil</option>
                        <option value="Japan">Japan</option>
                        <option value="Other">Other</option>
                      </select>
                      <select
                        name="subscriptionPlan"
                        value={org.subscriptionPlan}
                        onChange={handleOrgChange}
                        disabled={loading}
                      >
                        <option value="FREE">Free</option>
                        <option value="STARTER">Starter</option>
                        <option value="PRO">Pro</option>
                        <option value="ENTERPRISE">Enterprise</option>
                      </select>
                    </div>
                  {/* )} */}
                </>
              )}
              {/* <input
                type="text"
                name="name"
                placeholder="Organization name"
                value={org.name}
                onChange={handleOrgChange}
                disabled={loading}
              />
              <textarea
                name="bio"
                placeholder="Organization bio — what does your company do?"
                value={org.bio}
                onChange={handleOrgChange}
                disabled={loading}
                rows={3}
              />
              <input
                type="text"
                name="industry"
                placeholder="Industry (optional)"
                value={org.industry}
                onChange={handleOrgChange}
                disabled={loading}
              />
              <input
                type="text"
                name="country"
                placeholder="Country"
                value={org.country}
                onChange={handleOrgChange}
                disabled={loading}
              />
              <select
                name="subscriptionPlan"
                value={org.subscriptionPlan}
                onChange={handleOrgChange}
                disabled={loading}
              >
                <option value="FREE">Free</option>
                <option value="STARTER">Starter</option>
                <option value="PRO">Pro</option>
                <option value="ENTERPRISE">Enterprise</option>
              </select>
              {checkingOrg && (
                <p className="field-hint">Checking your organization…</p>
              )}

              {orgStatus?.valid && orgStatus.exists === true && (
                <p className="field-hint">
                  You'll join <strong>{orgStatus.organizationName}</strong>.
                </p>
              )} */}

              {/* New domain -> this person sets up the organization (org_admin).
              {isNewOrg && (
                <div className="org-setup">
                  <p className="org-setup-title">Set up your organization</p>
                  <p className="field-hint">
                    You're the first person from this domain, so you'll be the
                    organization admin.
                  </p>
                  <input
                    type="text"
                    name="name"
                    placeholder="Organization name"
                    value={org.name}
                    onChange={handleOrgChange}
                    disabled={loading}
                  />
                  <textarea
                    name="bio"
                    placeholder="Organization bio — what does your company do?"
                    value={org.bio}
                    onChange={handleOrgChange}
                    disabled={loading}
                    rows={3}
                  />
                  <input
                    type="text"
                    name="industry"
                    placeholder="Industry (optional)"
                    value={org.industry}
                    onChange={handleOrgChange}
                    disabled={loading}
                  />
                  <input
                    type="text"
                    name="country"
                    placeholder="Country"
                    value={org.country}
                    onChange={handleOrgChange}
                    disabled={loading}
                  />
                  <select
                    name="subscriptionPlan"
                    value={org.subscriptionPlan}
                    onChange={handleOrgChange}
                    disabled={loading}
                  >
                    <option value="FREE">Free</option>
                    <option value="STARTER">Starter</option>
                    <option value="PRO">Pro</option>
                    <option value="ENTERPRISE">Enterprise</option>
                  </select>
                </div>
              )} */}

              {formData.password && passwordRequirements.length > 0 && (
                <div className="password-requirements">
                  <p className="requirement-label">Password must have:</p>
                  <ul className="requirement-list">
                    {passwordRequirements.map((req, idx) => (
                      <li key={idx} className="requirement-item">
                        {req}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {error && <p className="error-message">{error}</p>}
              {/* <button type="submit" className="signup-btn" disabled={loading}>
                {loading ? "Creating Account..." : "Next"}
              </button> */}
              <button className="next-btn" disabled={loading}>
                {step === 1 ? "Next" : "Create"}
              </button>
            </form>
            <p className="login-text">
              Already have an account?
              <span onClick={() => navigate("/login")}> Log In</span>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default Signup;
