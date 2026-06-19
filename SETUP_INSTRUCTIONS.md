# SNAP-AI Authentication Security - Installation & Setup

## 🔧 Required Installations

### Backend
```bash
cd backend

# Install new packages for security
npm install helmet nodemailer

# Verify all packages installed
npm list

# Should include:
# - bcryptjs (password hashing)
# - jsonwebtoken (JWT tokens)
# - mysql2/promise (database)
# - dotenv (environment variables)
# - express (server)
# - helmet (security headers) ← NEW
# - nodemailer (email sending) ← NEW
# - cors (cross-origin requests)
```

### Frontend
```bash
cd frontend

# All packages should already be installed
# Just verify:
npm list

# Should include:
# - react, react-dom
# - react-router-dom (routing)
# - vite (bundler)
```

---

## 📧 Email Configuration

### Using Gmail (Easiest)
1. Go to your Gmail account
2. Enable 2-Step Verification
3. Create [App Password](https://myaccount.google.com/apppasswords)
4. Copy 16-character password
5. Add to `backend/.env`:
```env
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-16-char-app-password
FRONTEND_URL=http://localhost:5173
```

### Using Mailtrap (No real emails)
1. Sign up at [mailtrap.io](https://mailtrap.io)
2. Create project
3. Copy SMTP credentials
4. Update `backend/.env` (optional - uses transporter configuration)

### Using MailHog (Local - Recommended for dev)
```bash
# Install
brew install mailhog      # macOS
choco install mailhog     # Windows
apt-get install mailhog   # Linux

# Run
mailhog

# Open UI: http://localhost:1025 (emails appear here)
# SMTP: localhost:1025
```

---

## 📁 Database Migration

### Apply Email Verification Schema
```bash
cd backend

# Connect to MySQL and run migration:
mysql -u root -p snap_ai < sql/add-email-verification.sql

# Or manually run SQL from MySQL client:
# Copy contents of sql/add-email-verification.sql and execute
```

---

## 🧪 Testing Email Verification

### Step 1: Start Backend
```bash
cd backend
npm start

# Should see:
# "Connected to MySQL."
# "SNAP AI backend running on http://localhost:5000"
```

### Step 2: Start Frontend
```bash
cd frontend
npm run dev

# Should see:
# "Local: http://localhost:5173"
```

### Step 3: Test Signup with Email Verification
1. Go to `http://localhost:5173/signup`
2. Fill in form:
   - Name: `Test User`
   - Email: `test@example.com` (or your real email)
   - Password: `SecurePass123!@` (must match requirements)
   - Role: `Employee`
3. Click "Create Account"
4. Should see: "Check Your Email" message

### Step 4: Verify Email
1. Check your email inbox for verification link
   - If using MailHog: Go to `http://localhost:1025`
   - If using Gmail: Check inbox
   - If using Mailtrap: Check their inbox
2. Click the verification link
3. Should see: "Email verified successfully! Redirecting to login..."
4. Should automatically redirect to `/login`

### Step 5: Login Test
1. Go to `http://localhost:5173/login`
2. Enter credentials:
   - Email: `test@example.com`
   - Password: `SecurePass123!@`
3. Click "Log In"
4. Should login successfully and redirect to dashboard

---

## ✅ Verification Checklist

- [ ] Backend installed all packages (`npm list`)
- [ ] `backend/.env` has EMAIL_USER and EMAIL_PASSWORD
- [ ] Database migration executed (`sql/add-email-verification.sql`)
- [ ] Backend starts without errors (`npm start`)
- [ ] Frontend starts without errors (`npm run dev`)
- [ ] Signup form shows password requirements in real-time
- [ ] Password with weak requirements is rejected
- [ ] Email verification link received
- [ ] Email verification link works
- [ ] Can login only after email verified
- [ ] 5 failed login attempts locks account for 30 minutes
- [ ] Security headers present in responses (check DevTools)

---

## 🐛 Troubleshooting

### Email not sending
```bash
# 1. Check .env variables
cat backend/.env | grep EMAIL

# 2. Check server logs
# Should see email sending logs in console

# 3. If using Gmail:
# - Verify App Password (not account password)
# - Check 2FA is enabled
# - Try different email settings

# 4. If using MailHog:
# - Make sure mailhog is running
# - Check localhost:1025
```

### Signup not sending email
```bash
# Check backend console for errors
# Look for: "Email sending failed:" messages

# Common issues:
# 1. EMAIL_USER or EMAIL_PASSWORD missing in .env
# 2. FRONTEND_URL incorrect (missing from .env)
# 3. Email service not responding
```

### Verification link not working
```bash
# 1. Make sure FRONTEND_URL in .env is correct
# 2. Check token hasn't expired (24 hours)
# 3. Verify database has verification token:
mysql -u root -p snap_ai
SELECT email, email_verified, email_verification_expires FROM users WHERE email = 'test@example.com';
```

### Account locked can't login
```bash
# After 5 failed attempts, account locks for 30 min
# To unlock manually:
mysql -u root -p snap_ai
UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE email = 'test@example.com';
```

---

## 📝 Files Changed/Created

### Backend
- ✅ `server.js` - Added Helmet security headers
- ✅ `src/utils/validators.js` - Added password strength validation + sanitization
- ✅ `src/services/emailService.js` - NEW: Email sending service
- ✅ `src/controllers/authController.js` - Added email verification flow + account lockout
- ✅ `src/models/userModel.js` - Added verification methods
- ✅ `src/routes/authRoutes.js` - Added `/verify` endpoint
- ✅ `sql/add-email-verification.sql` - NEW: Database migration
- ✅ `.env` - Added EMAIL_USER, EMAIL_PASSWORD, FRONTEND_URL

### Frontend
- ✅ `src/services/authService.js` - Added `verifyEmail()` method
- ✅ `src/modules/auth/Signup.jsx` - Added password requirements display + verification message
- ✅ `src/modules/auth/Signup.css` - Added styles for requirements + success message
- ✅ `src/modules/auth/VerifyEmail.jsx` - NEW: Email verification page
- ✅ `src/modules/auth/VerifyEmail.css` - NEW: Verification page styles
- ✅ `src/routes/AppRoutes.jsx` - Added `/verify-email` route

### Documentation
- ✅ `SECURITY_GUIDE.md` - Comprehensive security implementation guide
- ✅ `SETUP_INSTRUCTIONS.md` - This file

---

## 🚀 Next: Easy Features to Add

### Rate Limiting (45 min)
Prevent brute force attacks by limiting login attempts

### Login Logging (1 hour)
Track all login attempts for audit trail

### Show/Hide Password Toggle (15 min)
Better UX for password field

Refer to `SECURITY_GUIDE.md` for detailed implementation steps.

---

**Ready to test? Start with Step 1 above! 🎉**
