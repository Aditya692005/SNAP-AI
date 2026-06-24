// src/utils/token.js

const jwt = require("jsonwebtoken");

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, department_id: user.department_id ?? null },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" },
  );
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

module.exports = { signToken, verifyToken };
