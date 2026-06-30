// src/middleware/requirePermission.js
//
// Authorize by PERMISSION (from role_permissions), not by role name. Use AFTER
// requireAuth so req.user.permissions is populated.
//   router.post("/", requireAuth, requirePermission("ASSIGN_DOCUMENTS"), handler);
//
// Passing several permissions requires the user to hold ALL of them.

const AppError = require("../utils/AppError");

function requirePermission(...required) {
  return function (req, res, next) {
    const held = (req.user && req.user.permissions) || [];
    const ok = required.every((p) => held.includes(p));
    if (!ok) {
      return next(new AppError("You do not have permission to do that.", 403));
    }
    return next();
  };
}

module.exports = requirePermission;
