// src/controllers/authController.js
//
// Implements the two endpoints the frontend (authService.js) calls:
//   POST /api/auth/login   { email, password }
//   POST /api/auth/signup  { name, email, password, role }
//
// Both respond with { token, user: { id, name, email, role } } on success.
// The password hash NEVER goes back to the client.

const bcrypt = require("bcryptjs");
const { findByEmail, findById, createUser } = require("../models/userModel");
const { signToken } = require("../utils/token");
const { validateLoginInput, validateSignupInput } = require("../utils/validators");
const AppError = require("../utils/AppError");

const SALT_ROUNDS = 10;

// POST /api/auth/login
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const validationError = validateLoginInput({ email, password });
    if (validationError) {
      throw new AppError(validationError, 400);
    }

    // Look the user up by email and check the value of usrnm/pwd against
    // what's stored in the database.
    const user = await findByEmail(email.trim().toLowerCase());

    // Same error message whether the email doesn't exist or the password
    // is wrong — this avoids leaking which emails are registered.
    if (!user) {
      throw new AppError("Invalid email or password.", 401);
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      throw new AppError("Invalid email or password.", 401);
    }

    const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role };
    const token = signToken(safeUser);

    return res.status(200).json({ token, user: safeUser });
  } catch (err) {
    return next(err);
  }
}

// POST /api/auth/signup
async function signup(req, res, next) {
  try {
    const { name, email, password, role } = req.body;

    const validationError = validateSignupInput({ name, email, password, role });
    if (validationError) {
      throw new AppError(validationError, 400);
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await findByEmail(normalizedEmail);
    if (existing) {
      throw new AppError("An account with this email already exists.", 409);
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const newUser = await createUser({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      role,
    });

    const token = signToken(newUser);

    return res.status(201).json({ token, user: newUser });
  } catch (err) {
    return next(err);
  }
}

// GET /api/auth/me  (protected — requires Authorization: Bearer <token>)
// Lets the Dashboard confirm who's logged in and re-fetch fresh user data
// straight from the database rather than trusting whatever's in localStorage.
async function getCurrentUser(req, res, next) {
  try {
    const user = await findById(req.user.id);
    if (!user) {
      throw new AppError("User not found.", 404);
    }
    return res.status(200).json({ user });
  } catch (err) {
    return next(err);
  }
}

module.exports = { login, signup, getCurrentUser };
