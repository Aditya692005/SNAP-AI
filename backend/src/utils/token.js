// src/utils/token.js

const jwt = require("jsonwebtoken");

// The JWT is the app's own auth (not Supabase Auth). It carries everything the
// middleware needs to authorize a request without a DB round-trip: the user's
// organization, role name, department, and resolved permission list.
function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      organization_id: user.organization_id ?? null,
      role: user.role ?? null,
      department_id: user.department_id ?? null,
      permissions: user.permissions ?? [],
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" },
  );
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

module.exports = { signToken, verifyToken };
