// Presentation helpers for the current user, shared by the UserMenu avatar and
// the Settings profile tab so the two can never drift apart.

export const ROLE_LABELS = {
  employee: "Employee",
  manager: "Manager",
  org_admin: "Company Admin",
  admin: "Administrator",
};

export function roleLabel(role) {
  return ROLE_LABELS[role] || role || "—";
}

// The avatar is derived, not uploaded: two letters from the name (first + last
// initial) or, failing that, from the email.
export function initials(name, email) {
  const base = (name || email || "?").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}
