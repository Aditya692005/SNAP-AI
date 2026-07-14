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
  // null = unknown yet; otherwise { valid, exists, organizationName }
  const [orgStatus, setOrgStatus] = useState(null);
  const [checkingOrg, setCheckingOrg] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [passwordRequirements, setPasswordRequirements] = useState([]);
  const [success, setSuccess] = useState(false);
  const [successEmail, setSuccessEmail] = useState("");

  const isNewOrg = orgStatus?.valid && orgStatus.exists === false;

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (name === "password") setPasswordRequirements(passwordProblems(value));
    // Email changed -> previous org check no longer applies.
    if (name === "email") setOrgStatus(null);
    setError("");
  };

  const handleOrgChange = (e) => {
    const { name, value } = e.target;
    setOrg((prev) => ({ ...prev, [name]: value }));
    setError("");
  };

  // When the email loses focus, find out if its domain already has an org so we
  // can show/hide the "set up your organization" section.
  const checkOrg = async (email) => {
    if (!email || !email.includes("@") || !email.split("@")[1]) return null;
    setCheckingOrg(true);
    try {
      const status = await authService.checkOrgStatus(email);
      setOrgStatus(status);
      if (status?.valid && status.exists === false) {
        // Prefill the org name with the domain-derived suggestion.
        setOrg((prev) => ({ ...prev, name: prev.name || status.organizationName || "" }));
      }
      return status;
    } catch {
      return null;
    } finally {
      setCheckingOrg(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (!formData.name || !formData.email || !formData.password) {
        throw new Error("Please fill in all fields");
      }
      if (passwordRequirements.length > 0) {
        throw new Error("Password does not meet requirements");
      }

      // Make sure we know whether this email's domain has an org (in case the
      // user never blurred the email field).
      let status = orgStatus;
      if (!status || !status.valid) {
        status = await checkOrg(formData.email);
      }
      const creatingOrg = status?.valid && status.exists === false;

      let orgPayload;
      if (creatingOrg) {
        if (!org.name.trim()) throw new Error("Organization name is required");
        if (!org.bio.trim()) throw new Error("Please add a short bio for your organization");
        if (!org.country.trim()) throw new Error("Please select your country");
        orgPayload = {
          name: org.name.trim(),
          bio: org.bio.trim(),
          industry: org.industry.trim(),
          country: org.country.trim(),
          subscriptionPlan: org.subscriptionPlan,
        };
      }

      await authService.signup(formData.name, formData.email, formData.password, orgPayload);

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
              The link expires in 10 minutes — if it does, just log in again to
              get a new one.
            </p>
            <p className="secondary-text">
              Didn't receive the email?{" "}
              <span
                onClick={() => {
                  setSuccess(false);
                  setFormData({ name: "", email: "", password: "" });
                  setOrg({ name: "", bio: "", industry: "", country: "", subscriptionPlan: "FREE" });
                  setOrgStatus(null);
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
                placeholder="Work Email Address"
                value={formData.email}
                onChange={handleChange}
                onBlur={(e) => checkOrg(e.target.value)}
                disabled={loading}
              />

              {checkingOrg && <p className="field-hint">Checking your organization…</p>}

              {orgStatus?.valid && orgStatus.exists === true && (
                <p className="field-hint">
                  You'll join <strong>{orgStatus.organizationName}</strong>.
                </p>
              )}

              {/* New domain -> this person sets up the organization (org_admin). */}
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
              )}

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
                          <li key={idx} className="requirement-item">
                            ❌ {req}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
              {error && <p className="error-message">{error}</p>}
              <button type="submit" className="signup-btn" disabled={loading}>
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
