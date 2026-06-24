// src/middleware/requireAuth.js
//
// Protects routes that need a logged-in user. Reads the JWT from the
// `Authorization: Bearer <token>` header (this is what apiClient.js on the
// frontend already sends automatically once a token is saved).

const { verifyToken } = require("../utils/token");
const { findById } = require("../models/userModel");
const AppError = require("../utils/AppError");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next(new AppError("Authentication required.", 401));
  }

  try {
    req.user = verifyToken(token); // { id, email, role, department_id }

    // Tokens issued before department/role were added (or stale ones) get the
    // current values backfilled from the DB so authorization stays correct.
    if (req.user.department_id == null || req.user.role == null) {
      const fresh = await findById(req.user.id);
      if (fresh) {
        req.user.department_id = req.user.department_id ?? fresh.department_id ?? null;
        req.user.role = req.user.role ?? fresh.role ?? "employee";
      }
    }
    return next();
  } catch {
    return next(new AppError("Session expired or invalid. Please log in again.", 401));
  }
}

module.exports = requireAuth;
