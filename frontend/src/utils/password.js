// The password policy, client-side. Must stay in step with the server's
// validatePasswordStrength() in backend/src/utils/validators.js — the server is
// the source of truth; this only exists so the user sees the rules as they type.
// Returns the list of UNMET requirements (empty array = valid).
export function passwordProblems(password) {
  const out = [];
  if (password.length < 12) out.push("At least 12 characters");
  if (!/[A-Z]/.test(password)) out.push("One uppercase letter");
  if (!/[a-z]/.test(password)) out.push("One lowercase letter");
  if (!/[0-9]/.test(password)) out.push("One number");
  if (!/[!@#$%^&*_-]/.test(password)) out.push("One special character");
  return out;
}
