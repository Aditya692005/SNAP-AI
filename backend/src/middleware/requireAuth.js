// src/middleware/requireAuth.js
//
// Protects routes that need a logged-in user. Reads the JWT from the
// `Authorization: Bearer <token>` header (this is what apiClient.js on the
// frontend already sends automatically once a token is saved).

const { verifyToken } = require("../utils/token");
const AppError = require("../utils/AppError");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next(new AppError("Authentication required.", 401));
  }

  try {
    req.user = verifyToken(token); // { id, email, role }
    return next();
  } catch {
    return next(new AppError("Session expired or invalid. Please log in again.", 401));
  }
}

module.exports = requireAuth;
