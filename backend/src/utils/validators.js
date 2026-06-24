// src/utils/validators.js
// Input validation and sanitization for auth endpoints

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Sanitize string inputs - remove dangerous characters
function sanitizeInput(input) {
  if (typeof input !== "string") return "";
  return input
    .trim()
    .replace(/[<>\"'`]/g, "") // Remove HTML/script tags
    .substring(0, 255); // Limit length
}

function isValidEmail(email) {
  return typeof email === "string" && EMAIL_PATTERN.test(email);
}

function validateLoginInput({ email, password }) {
  if (!email || !password) {
    return "Email and password are required.";
  }
  if (!isValidEmail(email)) {
    return "Please provide a valid email address.";
  }
  return null;
}

function validatePasswordStrength(password) {
  // Returns array of missing requirements, empty array if valid
  const errors = [];
  
  if (password.length < 12) errors.push("At least 12 characters");
  if (!/[A-Z]/.test(password)) errors.push("One uppercase letter");
  if (!/[a-z]/.test(password)) errors.push("One lowercase letter");
  if (!/[0-9]/.test(password)) errors.push("One number");
  if (!/[!@#$%^&*_-]/.test(password)) errors.push("One special character (!@#$%^&*_-)");
  
  return errors;
}

// Roles a user may self-select at signup (privileged roles are granted by an
// existing company admin, never self-assigned).
const SIGNUP_ROLES = ["employee", "manager"];
// All roles an admin may assign. "org_admin" is the company-wide admin.
const ASSIGNABLE_ROLES = ["employee", "manager", "org_admin"];

function validateSignupInput({ name, email, password, role, departmentId }) {
  // Sanitize inputs
  const sanitizedName = sanitizeInput(name);
  const sanitizedEmail = sanitizeInput(email).toLowerCase();

  if (!sanitizedName || !sanitizedEmail || !password || !role) {
    return "Name, email, password, and role are all required.";
  }
  if (sanitizedName.length < 2 || sanitizedName.length > 255) {
    return "Name must be between 2 and 255 characters.";
  }
  if (!isValidEmail(sanitizedEmail)) {
    return "Please provide a valid email address.";
  }

  const passwordErrors = validatePasswordStrength(password);
  if (passwordErrors.length > 0) {
    return `Password must have: ${passwordErrors.join(", ")}.`;
  }

  if (!SIGNUP_ROLES.includes(role)) {
    return `Role must be one of: ${SIGNUP_ROLES.join(", ")}.`;
  }
  if (!Number.isInteger(Number(departmentId)) || Number(departmentId) <= 0) {
    return "A valid department is required.";
  }
  return null;
}

module.exports = {
  isValidEmail,
  validateLoginInput,
  validateSignupInput,
  validatePasswordStrength,
  sanitizeInput,
  SIGNUP_ROLES,
  ASSIGNABLE_ROLES,
};
