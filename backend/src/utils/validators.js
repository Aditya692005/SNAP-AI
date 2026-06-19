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

function validateSignupInput({ name, email, password, role }) {
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
  
  const allowedRoles = ["employee", "manager", "admin"];
  if (!allowedRoles.includes(role)) {
    return `Role must be one of: ${allowedRoles.join(", ")}.`;
  }
  return null;
}

module.exports = { isValidEmail, validateLoginInput, validateSignupInput, validatePasswordStrength, sanitizeInput };
