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

  try {
    // { id, email, organization_id, role, department_id, permissions }
    req.user = verifyToken(token);

    // Tokens issued before organization/permissions were added (stale ones) get
    // their authorization context backfilled from the DB so gating stays correct.
    if (!Array.isArray(req.user.permissions)) {
      const fresh = await findById(req.user.id);
      if (fresh) {
        req.user.organization_id = req.user.organization_id ?? fresh.organization_id ?? null;
        req.user.role = req.user.role ?? fresh.role ?? null;
        req.user.department_id = req.user.department_id ?? fresh.department_id ?? null;
        req.user.permissions = await getPermissionsForRole(fresh.role_id);
      } else {
        req.user.permissions = [];
      }
    }
    return next();
  } catch {
    return next(new AppError("Session expired or invalid. Please log in again.", 401));
  }
}

module.exports = requireAuth;
