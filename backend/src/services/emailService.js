// src/services/emailService.js
// Email sending service using Nodemailer

const nodemailer = require("nodemailer");
const crypto = require("crypto");

// Configure your email service
// For production, use: SendGrid, AWS SES, Mailgun, or Gmail with App Password
const transporter = nodemailer.createTransport({
  service: "gmail", // or your email service
  pool: true, // reuse a single SMTP connection instead of reconnecting per email
  maxConnections: 3,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD, // Use app-specific password for Gmail
  },
  tls: {
    rejectUnauthorized: false  // remove this in actuall production. not safe!!
  }
});

// Generate random verification token
function generateVerificationToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function sendVerificationEmail(email, name, verificationToken) {
  const verificationLink = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

  const htmlContent = `
    <h2>Welcome to SNAP AI, ${name}!</h2>
    <p>Please verify your email address to complete your signup.</p>
    <p>
      <a href="${verificationLink}" style="
        display: inline-block;
        padding: 10px 20px;
        background-color: #ec4899;
        color: white;
        text-decoration: none;
        border-radius: 5px;
      ">
        Verify Email
      </a>
    </p>
    <p>Or copy this link: ${verificationLink}</p>
    <p>This link expires in 10 minutes. If it expires, just log in again to get a new one.</p>
    <p>If you didn't create this account, please ignore this email.</p>
  `;

  try {
    console.log(`[EMAIL] Sending verification email to: ${email}`);
    console.log(`[EMAIL] Using Gmail account: ${process.env.EMAIL_USER}`);
    
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Verify Your SNAP AI Email",
      html: htmlContent,
    });
    
    console.log(`[EMAIL] ✅ Successfully sent to: ${email}`);
    return true;
  } catch (err) {
    console.error(`[EMAIL] ❌ Failed to send email to ${email}:`, err.message);
    console.error(`[EMAIL] Error details:`, err);
    return false;
  }
}

async function sendPasswordResetEmail(email, name, otp) {
  const htmlContent = `
    <h2>Password Reset Request</h2>
    <p>Hi ${name}, we received a password reset request for your account.</p>
    <p>Use this one-time password (OTP) to reset your password:</p>
    <p style="
      display: inline-block;
      padding: 12px 22px;
      background-color: #f3f4f6;
      color: #111827;
      font-size: 28px;
      letter-spacing: 8px;
      font-weight: 700;
      border-radius: 8px;
    ">
      ${otp}
    </p>
    <p>This code expires in 10 minutes.</p>
    <p>If you didn't request this, you can safely ignore this email.</p>
  `;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "SNAP AI Password Reset OTP",
      html: htmlContent,
    });
    return true;
  } catch (err) {
    console.error("Email sending failed:", err);
    return false;
  }
}

async function sendInviteEmail(email, name, token, orgName) {
  const inviteLink = `${process.env.FRONTEND_URL}/accept-invite?token=${token}`;
  const org = orgName ? ` to <strong>${orgName}</strong>` : "";

  const htmlContent = `
    <h2>You're invited to SNAP AI</h2>
    <p>Hi ${name}, you've been added${org} on SNAP AI.</p>
    <p>Set your password to activate your account:</p>
    <p>
      <a href="${inviteLink}" style="
        display: inline-block;
        padding: 10px 20px;
        background-color: #ec4899;
        color: white;
        text-decoration: none;
        border-radius: 5px;
      ">
        Accept Invite
      </a>
    </p>
    <p>Or copy this link: ${inviteLink}</p>
    <p>This invite expires in 7 days.</p>
  `;

  try {
    console.log(`[EMAIL] Sending invite to: ${email}`);
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "You're invited to SNAP AI",
      html: htmlContent,
    });
    return true;
  } catch (err) {
    console.error(`[EMAIL] ❌ Failed to send invite to ${email}:`, err.message);
    return false;
  }
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendInviteEmail,
  generateVerificationToken,
};
