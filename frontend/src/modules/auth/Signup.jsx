import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authService } from "../../services/authService";
import "./Signup.css";

function Signup() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    organizationName: "",
    description: "",
    industry: "",
    contactEmail: "",
    country: "",
    subscriptionPlan: "FREE",
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    role: "admin",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [passwordRequirements, setPasswordRequirements] = useState([]);
  const [fieldErrors, setFieldErrors] = useState({});
  const [touchedFields, setTouchedFields] = useState({});
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [success, setSuccess] = useState(false);
  const [successEmail, setSuccessEmail] = useState("");

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

  const validateField = (name, value, currentData = formData) => {
    switch (name) {
      case "organizationName":
        return value.trim().length >= 2
          ? ""
          : "Organization name must be at least 2 characters.";
      case "contactEmail":
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
          ? ""
          : "Please enter a valid contact email.";
      case "country":
        return value.trim().length >= 2 ? "" : "Country is required.";
      case "name":
        return value.trim().length >= 2
          ? ""
          : "Your name must be at least 2 characters.";
      case "email":
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
          ? ""
          : "Please enter a valid email address.";
      case "password":
        return validatePasswordStrength(value).length === 0
          ? ""
          : "Password does not meet the required strength.";
      case "confirmPassword":
        return value === currentData.password ? "" : "Passwords do not match.";
      default:
        return "";
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    const nextValue = value;
    const nextFormData = { ...formData, [name]: nextValue };
    setFormData(nextFormData);

    if (name === "password") {
      setPasswordRequirements(validatePasswordStrength(nextValue));
    }

    const nextError = validateField(name, nextValue, nextFormData);
    setFieldErrors((prev) => ({ ...prev, [name]: nextError }));
    setError("");
  };

  const handleBlur = (e) => {
    const { name } = e.target;
    setTouchedFields((prev) => ({ ...prev, [name]: true }));
    const nextError = validateField(name, formData[name], formData);
    setFieldErrors((prev) => ({ ...prev, [name]: nextError }));
  };

  const showFieldError = (name) =>
    Boolean(touchedFields[name] && fieldErrors[name]);

  const handleNext = (e) => {
    e.preventDefault();
    setError("");

    const organizationFields = ["organizationName", "contactEmail", "country"];
    const organizationErrors = {};

    organizationFields.forEach((field) => {
      const error = validateField(field, formData[field], formData);
      organizationErrors[field] = error;
    });

    setFieldErrors((prev) => ({ ...prev, ...organizationErrors }));
    setTouchedFields((prev) => ({
      ...prev,
      ...Object.fromEntries(organizationFields.map((field) => [field, true])),
    }));

    const firstOrganizationError = organizationFields
      .map((field) => organizationErrors[field])
      .find(Boolean);

    if (firstOrganizationError) {
      setError(firstOrganizationError);
      return;
    }

    setStep(2);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const personalFields = ["name", "email", "password", "confirmPassword"];
      const personalErrors = {};

      personalFields.forEach((field) => {
        const error = validateField(field, formData[field], formData);
        personalErrors[field] = error;
      });

      setFieldErrors((prev) => ({ ...prev, ...personalErrors }));
      setTouchedFields((prev) => ({
        ...prev,
        ...Object.fromEntries(personalFields.map((field) => [field, true])),
      }));

      const firstPersonalError = personalFields
        .map((field) => personalErrors[field])
        .find(Boolean);

      if (firstPersonalError) {
        throw new Error(firstPersonalError);
      }

      if (passwordRequirements.length > 0) {
        throw new Error("Password does not meet requirements.");
      }

      await authService.signup(
        formData.name,
        formData.email,
        formData.password,
        formData.role,
        formData.organizationName,
        formData.description,
        formData.industry,
        formData.contactEmail,
        formData.country,
        formData.subscriptionPlan,
      );

      setSuccess(true);
      setSuccessEmail(formData.email);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setSuccess(false);
    setStep(1);
    setShowPassword(false);
    setShowConfirmPassword(false);
    setFormData({
      organizationName: "",
      description: "",
      industry: "",
      contactEmail: "",
      country: "",
      subscriptionPlan: "FREE",
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
      role: "admin",
    });
    setPasswordRequirements([]);
    setFieldErrors({});
    setTouchedFields({});
    setError("");
  };

  const handlePrimaryAction = (e) => {
    if (step === 1) {
      e.preventDefault();
      handleNext(e);
    }
  };

  const stepLabels = ["Organization details", "Account details"];

  return (
    <div className="signup-page">
      <div className="glow glow-1"></div>
      <div className="glow glow-2"></div>

      <div className="signup-card">
        {success ? (
          <>
            <div className="success-icon">✅</div>
            <h1>Check Your Email</h1>
            <p className="subtitle">
              We created your account and organization setup request for
            </p>
            <p className="email-highlight">{successEmail}</p>
            <p className="instruction">
              Click the verification link in your inbox to activate your
              account. <br />
              The link expires in 24 hours.
            </p>
            <p className="secondary-text">
              Didn’t receive the email?{" "}
              <span
                onClick={resetForm}
                style={{ cursor: "pointer", color: "#ec4899" }}
              >
                Try again
              </span>
            </p>
          </>
        ) : (
          <>
            <h1>Create Your Account</h1>
            <p className="subtitle">
              Set up your organization and start using SNAP AI
            </p>

            <div className="signup-step-indicator" aria-label="Signup progress">
              {stepLabels.map((label, index) => {
                const stepNumber = index + 1;
                const isActive = stepNumber <= step;
                return (
                  <div
                    key={label}
                    className={`step-pill ${isActive ? "active" : ""}`}
                  >
                    <span className="step-number">{stepNumber}</span>
                    <span>{label}</span>
                  </div>
                );
              })}
            </div>

            <form
              id="signup-form"
              className="signup-form"
              onSubmit={step === 1 ? handleNext : handleSubmit}
            >
              {step === 1 ? (
                <>
                  <div className="field-group">
                    <input
                      type="text"
                      name="organizationName"
                      placeholder="Organization Name"
                      value={formData.organizationName}
                      onChange={handleChange}
                      onBlur={handleBlur}
                      disabled={loading}
                    />
                    {showFieldError("organizationName") && (
                      <p className="field-error">
                        {fieldErrors.organizationName}
                      </p>
                    )}
                  </div>
                  <textarea
                    name="description"
                    placeholder="Short organization description"
                    value={formData.description}
                    onChange={handleChange}
                    disabled={loading}
                    rows="3"
                    style={{ resize: "vertical" }}
                  />
                  <input
                    type="text"
                    name="industry"
                    placeholder="Industry"
                    value={formData.industry}
                    onChange={handleChange}
                    disabled={loading}
                  />
                  <div className="field-group">
                    <input
                      type="email"
                      name="contactEmail"
                      placeholder="Contact Email"
                      value={formData.contactEmail}
                      onChange={handleChange}
                      onBlur={handleBlur}
                      disabled={loading}
                    />
                    {showFieldError("contactEmail") && (
                      <p className="field-error">{fieldErrors.contactEmail}</p>
                    )}
                  </div>
                  <div className="field-group">
                    <select
                      name="country"
                      value={formData.country}
                      onChange={handleChange}
                      onBlur={handleBlur}
                      disabled={loading}
                    >
                      <option value="">Select country</option>
                      <option value="United States">United States</option>
                      <option value="Canada">Canada</option>
                      <option value="United Kingdom">United Kingdom</option>
                      <option value="India">India</option>
                      <option value="Australia">Australia</option>
                      <option value="Germany">Germany</option>
                      <option value="France">France</option>
                      <option value="Singapore">Singapore</option>
                      <option value="UAE">UAE</option>
                      <option value="Other">Other</option>
                    </select>
                    {showFieldError("country") && (
                      <p className="field-error">{fieldErrors.country}</p>
                    )}
                  </div>
                  <select
                    name="subscriptionPlan"
                    value={formData.subscriptionPlan}
                    onChange={handleChange}
                    disabled={loading}
                  >
                    <option value="FREE">Free</option>
                    <option value="STARTER">Starter</option>
                    <option value="PRO">Pro</option>
                    <option value="ENTERPRISE">Enterprise</option>
                  </select>
                </>
              ) : (
                <>
                  <div className="field-group">
                    <input
                      type="text"
                      name="name"
                      placeholder="Your Full Name"
                      value={formData.name}
                      onChange={handleChange}
                      onBlur={handleBlur}
                      disabled={loading}
                    />
                    {showFieldError("name") && (
                      <p className="field-error">{fieldErrors.name}</p>
                    )}
                  </div>
                  <div className="field-group">
                    <input
                      type="email"
                      name="email"
                      placeholder="Your Email Address"
                      value={formData.email}
                      onChange={handleChange}
                      onBlur={handleBlur}
                      disabled={loading}
                    />
                    {showFieldError("email") && (
                      <p className="field-error">{fieldErrors.email}</p>
                    )}
                  </div>
                  <div className="field-group">
                    <div className="password-input-wrapper">
                      <input
                        type={showPassword ? "text" : "password"}
                        name="password"
                        placeholder="Password"
                        value={formData.password}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        disabled={loading}
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        className="password-toggle"
                        onClick={() => setShowPassword((prev) => !prev)}
                      >
                        {showPassword ? "Hide" : "Show"}
                      </button>
                    </div>
                    {showFieldError("password") && (
                      <p className="field-error">{fieldErrors.password}</p>
                    )}
                  </div>
                  <div className="field-group">
                    <div className="password-input-wrapper">
                      <input
                        type={showConfirmPassword ? "text" : "password"}
                        name="confirmPassword"
                        placeholder="Confirm Password"
                        value={formData.confirmPassword}
                        onChange={handleChange}
                        onBlur={handleBlur}
                        disabled={loading}
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        className="password-toggle"
                        onClick={() => setShowConfirmPassword((prev) => !prev)}
                      >
                        {showConfirmPassword ? "Hide" : "Show"}
                      </button>
                    </div>
                    {showFieldError("confirmPassword") && (
                      <p className="field-error">
                        {fieldErrors.confirmPassword}
                      </p>
                    )}
                  </div>
                  {formData.password && (
                    <div className="password-requirements">
                      {passwordRequirements.length === 0 ? (
                        <p className="requirement-valid">
                          ✅ Password meets all requirements
                        </p>
                      ) : (
                        <>
                          <p className="requirement-label">
                            Password must have:
                          </p>
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
                  <select
                    name="role"
                    value={formData.role}
                    onChange={handleChange}
                    disabled={loading}
                  >
                    <option value="admin">Administrator</option>
                    <option value="manager">Manager</option>
                    <option value="employee">Employee</option>
                  </select>
                </>
              )}
            </form>
          </>
        )}
        <p className="login-text">
          Already have an account?
          <span onClick={() => navigate("/login")}> Log In</span>
        </p>
        <div className="signup-actions">
          {step === 2 && (
            <button
              type="button"
              className="signup-btn"
              onClick={() => setStep(1)}
              disabled={loading}
              style={{ background: "#475569" }}
            >
              Back
            </button>
          )}
          <button
            type="submit"
            className="signup-btn"
            disabled={loading}
            form="signup-form"
            onClick={handlePrimaryAction}
          >
            {loading
              ? "Creating Account..."
              : step === 1
                ? "Next"
                : "Create Account"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Signup;
