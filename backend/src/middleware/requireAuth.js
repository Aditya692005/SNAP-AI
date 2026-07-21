// src/middleware/requireAuth.js
//
// Protects routes that need a logged-in user. Reads the JWT from the
// `Authorization: Bearer <token>` header (this is what apiClient.js on the
// frontend already sends automatically once a token is saved).

const { verifyToken } = require("../utils/token");
const { findById } = require("../models/userModel");
const { getPermissionsForRole } = require("../models/roleModel");
const AppError = require("../utils/AppError");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next(new AppError("Authentication required.", 401));
  }

  let decoded;
  try {
    // { id, email, organization_id, role, department_id, permissions }
    decoded = verifyToken(token);
  } catch {
    return next(new AppError("Session expired or invalid. Please log in again.", 401));
  }

  try {
    req.user = decoded;

    // Re-check the account on every request so an admin deactivating a user
    // takes effect immediately (stateless JWTs can't be revoked otherwise).
    const fresh = await findById(req.user.id);
    if (!fresh) {
      return next(new AppError("Your session is no longer valid. Please log in again.", 401));
    }
    if (fresh.status === "INACTIVE") {
      return next(new AppError("Your account has been deactivated.", 401));
    }

    // Reconcile the mutable authorization context from the DB on every request
    // so an admin's change (moving a user to another department, changing their
    // role) takes effect immediately instead of waiting for the JWT to expire
    // and be re-issued at re-login. The department especially drives which
    // department dashboard the user sees, so a stale token value would keep a
    // moved user pinned to their old team's board.
    req.user.organization_id = req.user.organization_id ?? fresh.organization_id ?? null;
    req.user.department_id = fresh.department_id ?? null;
    req.user.role = fresh.role ?? null;
    // Always recompute permissions from the DB rather than trusting the array
    // embedded in the JWT at login. A token-role-name comparison used to skip
    // this, but it missed two real cases: an admin EDITING a role's permission
    // set, and a user moved between two roles that share a name (custom roles).
    // Both must take effect on the next request, not the next login.
    req.user.permissions = await getPermissionsForRole(fresh.role_id);
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = requireAuth;
