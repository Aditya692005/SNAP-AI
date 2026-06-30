// src/middleware/requireRole.js
//
// Authorize by role. Use AFTER requireAuth so req.user is populated.
//   router.use(requireAuth, requireRole("org_admin"));

const AppError = require("../utils/AppError");

function requireRole(...allowed) {
  return function (req, res, next) {
    if (!req.user || !allowed.includes(req.user.role)) {
      return next(new AppError("You do not have permission to do that.", 403));
    }
    return next();
  };
}

module.exports = requireRole;
