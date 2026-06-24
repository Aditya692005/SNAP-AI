// src/routes/authRoutes.js

const express = require("express");
const { login, signup, verifyEmailToken, getCurrentUser } = require("../controllers/authController");
const requireAuth = require("../middleware/requireAuth");
const { listDepartments } = require("../models/departmentModel");

const router = express.Router();

router.post("/login", login);
router.post("/signup", signup);
router.post("/verify", verifyEmailToken); // Verify email with token
router.get("/me", requireAuth, getCurrentUser);

// Public: department list to populate the signup dropdown.
router.get("/departments", async (req, res, next) => {
  try {
    return res.json({ departments: await listDepartments() });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
