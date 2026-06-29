// src/controllers/authController.js
//
// Implements authentication endpoints:
//   POST /api/auth/login       { email, password }
//   POST /api/auth/signup      { name, email, password }
//   POST /api/auth/verify      { token }
//   GET  /api/auth/me          (protected)
//
// Signup requires email verification before login. Organization and role are
// derived from the email DOMAIN, not chosen by the user: the first user of a
// new domain creates the organization and becomes its org_admin; everyone else
// on that domain joins as an employee (department assigned later by an admin).

const bcrypt = require("bcryptjs");
const {
  findByEmail,
  findById,
  createUser,
  verifyEmail,
  updateFailedLoginAttempts,
  setVerificationToken,
} = require("../models/userModel");
const { findByDomain, findByContactEmail, createOrganization } = require("../models/organizationModel");
const { findRoleByName, getPermissionsForRole } = require("../models/roleModel");
const { signToken } = require("../utils/token");
const { validateLoginInput, validateSignupInput } = require("../utils/validators");
const { sendVerificationEmail, generateVerificationToken } = require("../services/emailService");
const AppError = require("../utils/AppError");

const SALT_ROUNDS = 10;
const SUBSCRIPTION_PLANS = ["FREE", "STARTER", "PRO", "ENTERPRISE"];
// How long an email-verification link stays valid.
const VERIFICATION_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Free / public email providers: the domain is shared by unrelated people, so
// it must NOT map to a single shared organization. Each such address becomes
// its own one-person org instead (keyed by the full email).
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com", "aol.com",
  "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com", "zoho.com",
]);

function isFreeEmailDomain(domain) {
  return FREE_EMAIL_DOMAINS.has(String(domain).toLowerCase());
}

// Locate the org for an email: by full address for free providers, by domain
// for corporate domains.
function findOrgForEmail(email, domain) {
  return isFreeEmailDomain(domain) ? findByContactEmail(email) : findByDomain(domain);
}

// Turn an email domain into a readable org name: "acme.com" -> "Acme".
function deriveOrgName(domain) {
  const label = domain.split(".")[0] || domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

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

    console.log(`[LOGIN] User found. Email verified: ${user.email_verified}, Account locked: ${user.locked_until}`);

    // Check if account is locked after failed attempts
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      console.log(`[LOGIN] ❌ Account locked for user: ${email}`);
      throw new AppError("Account temporarily locked. Try again later.", 429);
    }

    // Verify the password BEFORE anything else with side effects (like resending
    // a verification email), so those can't be triggered without valid creds.
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

    // Reset failed attempts on successful password check.
    await updateFailedLoginAttempts(user.id, 0, null);

    // Refuse deactivated (admin-removed) accounts.
    if (user.status === "INACTIVE") {
      console.log(`[LOGIN] ❌ Deactivated account: ${email}`);
      throw new AppError("This account has been deactivated. Contact your administrator.", 403);
    }

    // Not verified yet (e.g. the original link expired): issue a FRESH link and
    // stop here. Logging in again is the way to get a new verification email.
    if (!user.email_verified) {
      console.log(`[LOGIN] ✉️  Unverified login — issuing a new verification link for: ${email}`);
      const verificationToken = generateVerificationToken();
      const verificationExpires = new Date(Date.now() + VERIFICATION_TTL_MS);
      await setVerificationToken(user.id, verificationToken, verificationExpires);
      sendVerificationEmail(user.email, user.name, verificationToken).catch((e) =>
        console.error(`[LOGIN] ❌ Resend email failed for ${email}:`, e.message)
      );
      throw new AppError(
        "Your email isn't verified yet. We've sent you a new verification link — it expires in 10 minutes.",
        403
      );
    }

    console.log(`[LOGIN] ✅ Login successful for user: ${email}`);
    const permissions = await getPermissionsForRole(user.role_id);
    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organization_id: user.organization_id,
      department_id: user.department_id ?? null,
      permissions,
    };
    const token = signToken(safeUser);

    return res.status(200).json({ token, user: safeUser });
  } catch (err) {
    return next(err);
  }
}

// GET /api/auth/org-status?email=...  (public, pre-signup)
// Lets the signup form know whether the email's domain already has an
// organization. If not, this signup will create it and the form collects the
// organization details (name/bio/industry) from the would-be org_admin.
async function orgStatus(req, res, next) {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    const domain = email.split("@")[1];
    if (!email.includes("@") || !domain) {
      return res.json({ valid: false });
    }
    const org = await findOrgForEmail(email, domain);
    const free = isFreeEmailDomain(domain);
    return res.json({
      valid: true,
      exists: !!org,
      domain,
      // For free providers there's no meaningful domain-derived name, so let the
      // user name their org themselves.
      organizationName: org ? org.name : (free ? "" : deriveOrgName(domain)),
    });
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
      organizationName,
      organizationBio,
      organizationIndustry,
      organizationCountry,
      organizationSubscriptionPlan,
    } = req.body;
    console.log(`[SIGNUP] New signup request: ${email}`);

    const validationError = validateSignupInput({ name, email, password });
    if (validationError) {
      throw new AppError(validationError, 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const domain = normalizedEmail.split("@")[1];
    if (!domain) {
      throw new AppError("Please provide a valid email address.", 400);
    }

    const existing = await findByEmail(normalizedEmail);
    if (existing) {
      throw new AppError("An account with this email already exists.", 409);
    }

    // Resolve (or create) the organization for this email. When none exists,
    // this user is the org_admin and sets up the org here. Free email providers
    // are keyed by full address so unrelated people don't share an org.
    let organization = await findOrgForEmail(normalizedEmail, domain);
    let roleName = "employee";
    if (!organization) {
      const orgName = (organizationName && organizationName.trim()) || deriveOrgName(domain);
      let plan = String(organizationSubscriptionPlan || "FREE").toUpperCase();
      if (!SUBSCRIPTION_PLANS.includes(plan)) plan = "FREE";
      try {
        organization = await createOrganization({
          name: orgName,
          contactEmail: normalizedEmail,
          description: organizationBio ? String(organizationBio).trim() : null,
          industry: organizationIndustry ? String(organizationIndustry).trim() : null,
          country: organizationCountry ? String(organizationCountry).trim() : "Unknown",
          subscriptionPlan: plan,
        });
        roleName = "org_admin"; // first user of a brand-new org runs it
        console.log(`[SIGNUP] Created organization '${organization.name}' (${plan}) for ${normalizedEmail}`);
      } catch (e) {
        // Race: another signup created the org first. Re-fetch and join instead.
        organization = await findOrgForEmail(normalizedEmail, domain);
        if (!organization) throw e;
        roleName = "employee";
      }
    }

    const role = await findRoleByName(roleName);
    if (!role) {
      throw new AppError(`Server misconfigured: missing '${roleName}' role. Run seed-roles.sql.`, 500);
    }

    console.log(`[SIGNUP] Creating ${roleName} account for: ${normalizedEmail}`);
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const verificationToken = generateVerificationToken();
    const verificationExpires = new Date(Date.now() + VERIFICATION_TTL_MS);

    await createUser({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      organizationId: organization.id,
      roleId: role.id,
      departmentId: null, // assigned later by an org_admin
      verificationToken,
      verificationExpires,
    });

    console.log(`[SIGNUP] User created. Sending verification email in background...`);
    // Send verification email without blocking the response — Gmail SMTP can
    // take several seconds, and the result is only used for logging.
    sendVerificationEmail(normalizedEmail, name, verificationToken)
      .then((emailSent) => {
        if (!emailSent) {
          console.warn(`[SIGNUP] ⚠️  Failed to send verification email to: ${normalizedEmail}`);
        } else {
          console.log(`[SIGNUP] ✅ Verification email sent successfully to: ${normalizedEmail}`);
        }
      })
      .catch((err) => {
        console.error(`[SIGNUP] ❌ Email send error for ${normalizedEmail}:`, err.message);
      });

    return res.status(201).json({
      message: "Account created! Check your email to verify your address.",
      email: normalizedEmail,
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
    console.log(`[VERIFY] Email verification request with token: ${token?.substring(0, 10)}...`);

    if (!token) {
      throw new AppError("Verification token required.", 400);
    }

    const user = await verifyEmail(token);
    if (!user) {
      console.error(`[VERIFY] ❌ Invalid or expired token`);
      throw new AppError("Invalid or expired verification token.", 400);
    }

    console.log(`[VERIFY] ✅ Email verified for user ID: ${user.id}, Email: ${user.email}`);

    // User is now verified, return user data (they can now login)
    const safeUser = { id: user.id, email: user.email };
    return res.status(200).json({
      message: "Email verified successfully! You can now login.",
      user: safeUser,
    });
  } catch (err) {
    console.error(`[VERIFY] ❌ Error:`, err.message);
    return next(err);
  }
}

// GET /api/auth/me  (protected — requires Authorization: Bearer <token>)
// Returns the user plus their permission list so the frontend can render the
// correct landing page / hide actions the user can't perform.
async function getCurrentUser(req, res, next) {
  try {
    const user = await findById(req.user.id);
    if (!user) {
      throw new AppError("User not found.", 404);
    }
    const permissions = await getPermissionsForRole(user.role_id);
    return res.status(200).json({ user: { ...user, permissions } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { login, signup, verifyEmailToken, getCurrentUser, orgStatus };
