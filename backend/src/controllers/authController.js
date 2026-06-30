// src/controllers/authController.js
//
// Implements authentication endpoints:
//   POST /api/auth/login       { email, password }
//   POST /api/auth/signup      { name, email, password, role }
//   POST /api/auth/verify      { token }
//   GET  /api/auth/me          (protected)
//
// Signup now requires email verification before login.

const bcrypt = require("bcryptjs");
const {
  findByEmail,
  findById,
  createUser,
  createOrganization,
  createAdminRoleWithPermissions,
  createDepartment,
  updateRoleCreatedBy,
  verifyEmail,
  updateFailedLoginAttempts,
  updateVerificationToken,
} = require("../models/userModel");
const { signToken } = require("../utils/token");
const {
  validateLoginInput,
  validateSignupInput,
} = require("../utils/validators");
const {
  sendVerificationEmail,
  generateVerificationToken,
} = require("../services/emailService");
const AppError = require("../utils/AppError");

const SALT_ROUNDS = 10;

// POST /api/auth/login
async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    console.log(`[LOGIN] Login attempt for: ${email}`);

    const validationError = validateLoginInput({ email, password });
    if (validationError) {
      throw new AppError(validationError, 400);
    }

    const user = await findByEmail(email.trim().toLowerCase());

    if (!user) {
      console.log(`[LOGIN] ❌ User not found: ${email}`);
      throw new AppError("Invalid email or password.", 401);
    }

    console.log(
      `[LOGIN] User found. Email verified: ${user.email_verified}, Account locked: ${user.locked_until}`,
    );

    // Check if account is locked after failed attempts
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      console.log(`[LOGIN] ❌ Account locked for user: ${email}`);
      throw new AppError("Account temporarily locked. Try again later.", 429);
    }

    // Check if email is verified
    if (!user.email_verified) {
      console.log(`[LOGIN] ❌ Email not verified for user: ${email}`);
      throw new AppError("Please verify your email before logging in.", 403);
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      console.log(`[LOGIN] ❌ Password mismatch for user: ${email}`);
      // Increment failed attempts
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      let lockedUntil = null;

      if (newAttempts >= 5) {
        // Lock for 30 minutes
        lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      }

      await updateFailedLoginAttempts(user.id, newAttempts, lockedUntil);
      throw new AppError("Invalid email or password.", 401);
    }

    // Reset failed attempts on successful login
    await updateFailedLoginAttempts(user.id, 0, null);

    console.log(`[LOGIN] ✅ Login successful for user: ${email}`);
    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    };
    const token = signToken(safeUser);

    return res.status(200).json({ token, user: safeUser });
  } catch (err) {
    return next(err);
  }
}

// POST /api/auth/signup
async function signup(req, res, next) {
  try {
    const {
      name,
      email,
      password,
      role,
      organizationName,
      description,
      industry,
      contactEmail,
      country,
      subscriptionPlan,
    } = req.body;
    console.log(`[SIGNUP] New signup request: ${email}`);

    const validationError = validateSignupInput({
      name,
      email,
      password,
      role,
      organizationName,
      description,
      industry,
      contactEmail,
      country,
      subscriptionPlan,
    });
    if (validationError) {
      throw new AppError(validationError, 400);
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await findByEmail(normalizedEmail);

    if (existing) {
      if (existing.email_verified) {
        throw new AppError("An account with this email already exists.", 409);
      }

      // Existing but not verified

      const verificationToken = generateVerificationToken();
      const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await updateVerificationToken(
        existing.id,
        verificationToken,
        verificationExpires,
      );

      await sendVerificationEmail(
        normalizedEmail,
        existing.name,
        verificationToken,
      );

      return res.status(200).json({
        status: "RESENT",
        message:
          "Your account already exists but hasn't been verified. A new verification email has been sent.",
      });
    }

    console.log(
      `[SIGNUP] Creating organization and user account for: ${normalizedEmail}`,
    );
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const verificationToken = generateVerificationToken();
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const organization = await createOrganization({
      name: organizationName.trim(),
      description: description?.trim() || null,
      industry: industry?.trim() || null,
      contactEmail: contactEmail?.trim() || normalizedEmail,
      country: country?.trim() || "Unknown",
      subscriptionPlan: subscriptionPlan || "FREE",
      status: "ACTIVE",
    });

    const createdRole = await createAdminRoleWithPermissions({
      organizationId: organization.id,
    });

    const department = await createDepartment({
      organizationId: organization.id,
      name: "General",
      description: "Default department",
    });

    const newUser = await createUser({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      verificationToken,
      verificationExpires,
      organizationId: organization.id,
      roleId: createdRole.id,
      departmentId: department.id,
    });

    await updateRoleCreatedBy(createdRole.id, newUser.id);

    console.log(`[SIGNUP] User created. Sending verification email...`);
    const emailSent = await sendVerificationEmail(
      normalizedEmail,
      name,
      verificationToken,
    );

    if (!emailSent) {
      console.warn(
        `[SIGNUP] ⚠️  Failed to send verification email to: ${normalizedEmail}`,
      );
    } else {
      console.log(
        `[SIGNUP] ✅ Verification email sent successfully to: ${normalizedEmail}`,
      );
    }

    return res.status(201).json({
      message: "Account created! Check your email to verify your address.",
      email: normalizedEmail,
      organization: organization.name,
      user: newUser,
    });
  } catch (err) {
    console.error(`[SIGNUP] ❌ Error:`, err.message);
    return next(err);
  }
}

// POST /api/auth/verify - Verify email with token
async function verifyEmailToken(req, res, next) {
  try {
    const { token } = req.body;
    console.log(
      `[VERIFY] Email verification request with token: ${token?.substring(0, 10)}...`,
    );

    if (!token) {
      throw new AppError("Verification token required.", 400);
    }

    const verifiedUser = await verifyEmail(token);
    if (!verifiedUser) {
      console.error(`[VERIFY] ❌ Invalid or expired token`);
      throw new AppError("Invalid or expired verification token.", 400);
    }

    const fullUser = await findById(verifiedUser.id);
    if (!fullUser) {
      throw new AppError("User not found after verification.", 404);
    }

    console.log(
      `[VERIFY] ✅ Email verified for user ID: ${fullUser.id}, Email: ${fullUser.email}`,
    );

    const safeUser = {
      id: fullUser.id,
      name: fullUser.name,
      email: fullUser.email,
      role: fullUser.role,
    };
    const authToken = signToken(safeUser);

    return res.status(200).json({
      message: "Email verified successfully!",
      user: safeUser,
      token: authToken,
    });
  } catch (err) {
    console.error(`[VERIFY] ❌ Error:`, err.message);
    return next(err);
  }
}

// GET /api/auth/me  (protected — requires Authorization: Bearer <token>)
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

module.exports = { login, signup, verifyEmailToken, getCurrentUser };
