// src/routes/authRoutes.js

const express = require("express");
const { login, signup, getCurrentUser } = require("../controllers/authController");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

router.post("/login", login);
router.post("/signup", signup);
router.get("/me", requireAuth, getCurrentUser);

module.exports = router;
