// src/routes/authRoutes.js

const express = require("express");
const {
  login,
  signup,
  verifyEmailToken,
  getCurrentUser,
  orgStatus,
  emailExists,
  forgotPassword,
  resetPassword,
  changePassword,
  inviteInfo,
  acceptInvite,
} = require("../controllers/authController");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

router.post("/login", login);
router.post("/signup", signup);
router.post("/verify", verifyEmailToken); // Verify email with token
router.get("/me", requireAuth, getCurrentUser);
// Public: does this email's domain already have an organization? Drives whether
// the signup form shows the "set up your organization" fields.
router.get("/org-status", orgStatus);
// Public: does an account for this email already exist?
router.get("/email-exists", emailExists);

// Password flows
router.post("/forgot-password", forgotPassword); // public: email a reset link
router.post("/reset-password", resetPassword); // public: set new password via token
router.post("/change-password", requireAuth, changePassword); // logged-in: current + new

// Invitations (admin-added users)
router.get("/invite-info", inviteInfo); // public: who is this invite for?
router.post("/accept-invite", acceptInvite); // public: set password + activate

// NOTE: the old public GET /departments route is gone. Departments are now
// per-organization and signup no longer asks for one (org + role are derived
// from the email domain). Departments are listed under the authenticated,
// org-scoped GET /api/admin/departments instead.

module.exports = router;
