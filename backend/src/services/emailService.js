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

async function sendPasswordResetEmail(email, name, resetToken) {
  const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

  const htmlContent = `
    <h2>Password Reset Request</h2>
    <p>Hi ${name}, we received a password reset request for your account.</p>
    <p>
      <a href="${resetLink}" style="
        display: inline-block;
        padding: 10px 20px;
        background-color: #ec4899;
        color: white;
        text-decoration: none;
        border-radius: 5px;
      ">
        Reset Password
      </a>
    </p>
    <p>This link expires in 1 hour.</p>
    <p>If you didn't request this, ignore this email.</p>
  `;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "SNAP AI Password Reset",
      html: htmlContent,
    });
    return true;
  } catch (err) {
    console.error("Email sending failed:", err);
    return false;
  }
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  generateVerificationToken,
};
