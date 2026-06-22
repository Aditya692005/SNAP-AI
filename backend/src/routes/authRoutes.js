// src/routes/authRoutes.js

const express = require("express");
const { login, signup, verifyEmailToken, getCurrentUser } = require("../controllers/authController");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

router.post("/login", login);
router.post("/signup", signup);
router.post("/verify", verifyEmailToken); // Verify email with token
router.get("/me", requireAuth, getCurrentUser);

module.exports = router;
