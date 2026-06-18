// src/models/userModel.js
//
// All raw SQL for the `users` table lives here. Controllers never write
// SQL directly — they call these functions instead.

const { pool } = require("../config/db");

async function findByEmail(email) {
  const [rows] = await pool.query(
    "SELECT id, name, email, password_hash, role, created_at FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await pool.query(
    "SELECT id, name, email, role, created_at FROM users WHERE id = ? LIMIT 1",
    [id],
  );
  return rows[0] || null;
}

async function createUser({ name, email, passwordHash, role }) {
  const [result] = await pool.query(
    "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)",
    [name, email, passwordHash, role],
  );

  return {
    id: result.insertId,
    name,
    email,
    role,
  };
}

module.exports = { findByEmail, findById, createUser };
