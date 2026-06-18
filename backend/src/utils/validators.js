// src/utils/validators.js

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function validateSignupInput({ name, email, password, role }) {
  if (!name || !email || !password || !role) {
    return "Name, email, password, and role are all required.";
  }
  if (!isValidEmail(email)) {
    return "Please provide a valid email address.";
  }
  if (password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  const allowedRoles = ["employee", "manager", "admin"];
  if (!allowedRoles.includes(role)) {
    return `Role must be one of: ${allowedRoles.join(", ")}.`;
  }
  return null;
}

module.exports = { isValidEmail, validateLoginInput, validateSignupInput };
