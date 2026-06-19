// src/models/userModel.js
//
// All raw SQL for the `users` table lives here. Controllers never write
// SQL directly — they call these functions instead.

const { pool } = require("../config/db");

async function findByEmail(email) {
  const [rows] = await pool.query(
    "SELECT id, name, email, password_hash, role, email_verified, failed_login_attempts, locked_until, created_at FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await pool.query(
    "SELECT id, name, email, role, email_verified, created_at FROM users WHERE id = ? LIMIT 1",
    [id],
  );
  return rows[0] || null;
}

async function createUser({ name, email, passwordHash, role, verificationToken, verificationExpires }) {
  const [result] = await pool.query(
    "INSERT INTO users (name, email, password_hash, role, email_verified, email_verification_token, email_verification_expires) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [name, email, passwordHash, role, false, verificationToken, verificationExpires],
  );

  return {
    id: result.insertId,
    name,
    email,
    role,
    email_verified: false,
  };
}

async function verifyEmail(verificationToken) {
  // Check if token exists and hasn't expired
  const [rows] = await pool.query(
    "SELECT id, email, email_verification_expires FROM users WHERE email_verification_token = ? LIMIT 1",
    [verificationToken],
  );

  if (!rows[0]) {
    console.error("[DB] Token not found in database");
    return null; // Token not found
  }

  const user = rows[0];
  const expiresAt = new Date(user.email_verification_expires);
  const now = new Date();
  
  if (expiresAt < now) {
    console.error(`[DB] Token expired. Expires: ${expiresAt}, Now: ${now}`);
    return null; // Token expired
  }

  console.log(`[DB] Updating user ${user.id} (${user.email}) as verified...`);
  
  // Update user as verified
  const result = await pool.query(
    "UPDATE users SET email_verified = true, email_verification_token = NULL, email_verification_expires = NULL WHERE id = ?",
    [user.id],
  );

  console.log(`[DB] ✅ Update result:`, result[0]);

  return user;
}

async function findByVerificationToken(token) {
  const [rows] = await pool.query(
    "SELECT id, name, email FROM users WHERE email_verification_token = ? LIMIT 1",
    [token],
  );
  return rows[0] || null;
}

async function updateFailedLoginAttempts(userId, attempts, lockedUntil) {
  await pool.query(
    "UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?",
    [attempts, lockedUntil, userId],
  );
}

module.exports = { findByEmail, findById, createUser, verifyEmail, findByVerificationToken, updateFailedLoginAttempts };
