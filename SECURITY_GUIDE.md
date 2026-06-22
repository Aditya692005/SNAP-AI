# SNAP-AI Security Implementation Guide

## ✅ IMPLEMENTED FEATURES

### **1. Strong Password Validation** ✅ DONE
- **Requirements:**
  - Minimum 12 characters
  - At least 1 uppercase letter
  - At least 1 lowercase letter
  - At least 1 number
  - At least 1 special character (!@#$%^&*_-)

- **Frontend:** Real-time password strength feedback in Signup form
- **Backend:** Server-side validation in `validators.js`
- **Files:** 
  - `frontend/src/modules/auth/Signup.jsx`
  - `backend/src/utils/validators.js`

---

### **2. Input Sanitization** ✅ DONE
- **What it does:** Removes potentially dangerous HTML/script tags
- **Implementation:** `sanitizeInput()` function in `validators.js`
- **Protection:** Prevents XSS (Cross-Site Scripting) attacks
- **Scope:** All user inputs (name, email) are sanitized before database storage

---

### **3. Security Headers** ✅ DONE
- **Library:** Helmet.js
- **Headers Added:**
  - `X-Content-Type-Options: nosniff` - Prevents MIME sniffing
  - `X-Frame-Options: DENY` - Prevents clickjacking
  - `X-XSS-Protection` - XSS protection
  - `Strict-Transport-Security` - HTTPS enforcement
- **File:** `backend/server.js`

---

### **4. Email Verification** ✅ DONE
- **Flow:**
  1. User signs up with email
  2. Backend generates verification token (24-hour expiry)
  3. Email sent to user with verification link
  4. User clicks link → token verified → account activated
  5. Only verified accounts can login

- **Database Changes:**
  - Added `email_verified` (boolean)
  - Added `email_verification_token` (string)
  - Added `email_verification_expires` (datetime)
  - Added `failed_login_attempts` (int) for account lockout
  - Added `locked_until` (datetime) for lockout duration

- **Files:**
  - `backend/sql/add-email-verification.sql` - Database migration
  - `backend/src/services/emailService.js` - Email sending service
  - `backend/src/controllers/authController.js` - Updated with verification logic
  - `frontend/src/modules/auth/VerifyEmail.jsx` - Verification page
  - `frontend/src/routes/AppRoutes.jsx` - Added `/verify-email` route

---

### **5. Account Lockout (After Failed Attempts)** ✅ DONE
- **Rules:**
  - 5 failed login attempts → 30-minute lockout
  - `failed_login_attempts` counter resets on successful login
  - User sees error: "Account temporarily locked. Try again later."
- **File:** `backend/src/controllers/authController.js`

---

### **6. Password Hashing** ✅ ALREADY IN PLACE
- **Library:** bcrypt
- **Rounds:** 10 (good security, ~100ms per hash)
- **Recommendation:** Can increase to 12-14 for more security (slower but safer)

---

## ⏳ EASY TO ADD NEXT

### **Priority: HIGH (Recommended)**

#### **7. Rate Limiting** (45 minutes)
```bash
npm install express-rate-limit
```

Add to `backend/server.js`:
```javascript
const rateLimit = require("express-rate-limit");

// 5 login attempts per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
});

// 3 signup attempts per hour
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
});

app.post("/api/auth/login", loginLimiter, login);
app.post("/api/auth/signup", signupLimiter, signup);
```

**Benefits:** Prevents brute force attacks

---

#### **8. Login Activity Logging** (1 hour)
Create login logs table to track all login attempts:
```sql
CREATE TABLE login_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  ip_address VARCHAR(45),
  user_agent VARCHAR(255),
  status ENUM('success', 'failed'),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

Log every attempt:
```javascript
// In authController.js after each login attempt
await createLoginLog({
  userId: user?.id,
  ipAddress: req.ip,
  userAgent: req.get("user-agent"),
  status: "success" || "failed",
});
```

---

#### **9. Show/Hide Password Toggle** (15 minutes)
Add password visibility toggle in Login/Signup forms:
```jsx
const [showPassword, setShowPassword] = useState(false);

<input
  type={showPassword ? "text" : "password"}
  name="password"
/>
<button onClick={() => setShowPassword(!showPassword)}>
  {showPassword ? "Hide" : "Show"}
</button>
```

---

### **Priority: MEDIUM (Nice to have)**

#### **10. Password Reset Flow** (2 hours)
- User requests password reset
- Send email with reset link (1-hour expiry)
- User sets new password
- All existing sessions invalidated

#### **11. Refresh Token Rotation** (1.5 hours)
- Access token: 15 minutes (short-lived)
- Refresh token: 7 days (long-lived, httpOnly cookie)
- Tokens rotated on every refresh

---

### **Priority: ADVANCED**

#### **12. Two-Factor Authentication (2FA)** (3 hours)
- TOTP (Time-based One-Time Password)
- Integration with Google Authenticator

#### **13. Session Management** (2 hours)
- Track multiple login devices
- Allow logout from other devices
- Detect suspicious logins

---

## 🚀 HOW TO TEST EMAIL VERIFICATION

### **Option 1: Using Gmail (Easiest)**
1. Create Gmail account for testing
2. Enable 2FA on Gmail
3. Generate [App Password](https://myaccount.google.com/apppasswords)
4. Update `.env`:
   ```
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASSWORD=app-password-from-gmail
   FRONTEND_URL=http://localhost:5173
   ```
5. Test signup - you'll receive verification email in test Gmail inbox

### **Option 2: Using Mailtrap (No real emails sent)**
1. Go to [Mailtrap.io](https://mailtrap.io) → Sign up
2. Create project
3. Copy SMTP credentials
4. Update `.env` with Mailtrap credentials
5. Emails appear in Mailtrap inbox

### **Option 3: Using MailHog (Local testing)**
```bash
# Install MailHog
brew install mailhog  # macOS
choco install mailhog # Windows

# Run MailHog
mailhog

# Access UI at http://localhost:1025
# Update .env:
EMAIL_HOST=localhost
EMAIL_PORT=1025
```

---

## 📋 SETUP CHECKLIST

### **Backend Setup**
- [ ] Install dependencies: `npm install helmet nodemailer`
- [ ] Run database migration: `sql/add-email-verification.sql`
- [ ] Update `.env` with email credentials
- [ ] Verify `FRONTEND_URL` is set correctly
- [ ] Test server starts: `npm start`

### **Frontend Setup**
- [ ] Verify VerifyEmail component created
- [ ] Verify `/verify-email` route added
- [ ] Test signup form password validation works
- [ ] Test real-time password feedback displays

### **Email Testing**
- [ ] Sign up with test email
- [ ] Check email inbox for verification link
- [ ] Click link - should verify
- [ ] Try logging in - should work after verification
- [ ] Try logging in without verification - should fail with message

### **Security Testing**
- [ ] Test weak password rejected
- [ ] Test 5 failed logins lock account
- [ ] Test HTML injection in name field (should be sanitized)
- [ ] Check browser DevTools → Network → Headers for Helmet headers

---

## 🔒 Security Best Practices for Deployment

Before deploying to production:

1. **Update environment variables**
   ```env
   NODE_ENV=production
   JWT_SECRET=very-long-random-string-with-special-chars
   EMAIL_PASSWORD=use-app-specific-password
   CORS_ORIGIN=https://yourdomain.com  # Not localhost
   FRONTEND_URL=https://yourdomain.com
   ```

2. **Enable HTTPS/SSL** - Use Let's Encrypt (free)

3. **Add `.env` to `.gitignore`** - NEVER commit secrets

4. **Increase bcrypt rounds to 12**
   ```javascript
   const SALT_ROUNDS = 12; // Production (slower but safer)
   ```

5. **Implement rate limiting** (see above)

6. **Enable database backups** - Automated daily backups

7. **Monitor auth logs** - Alert on suspicious activity

---

## 📊 Current Security Score

| Feature | Status | Impact |
|---------|--------|--------|
| Strong Passwords | ✅ | High |
| Input Sanitization | ✅ | High |
| Security Headers | ✅ | High |
| Email Verification | ✅ | High |
| Account Lockout | ✅ | Medium |
| Password Hashing (bcrypt) | ✅ | High |
| Rate Limiting | ⏳ | High |
| Logging/Monitoring | ⏳ | Medium |
| HTTPS Enforcement | ⏳ | High |
| 2FA Support | ⏳ | Medium |

**Overall: 60/100 (Good for MVP, needs improvements for production)**

---

## 🎯 Next Steps

1. **This week:** Test email verification end-to-end
2. **Next week:** Add rate limiting + logging
3. **Before production:** Add HTTPS + increase bcrypt rounds
4. **Later:** Add 2FA + password reset flow

---

## 📞 Troubleshooting

### **Email not sending**
```
Check:
1. EMAIL_USER and EMAIL_PASSWORD in .env
2. Gmail: Enabled App Passwords (not regular password)
3. Firewall: Port 587 (Gmail) open
4. Console logs: npm start
```

### **Verification link broken**
```
Check:
1. FRONTEND_URL in .env ends without /
2. Verify token generated correctly
3. Token not expired (24 hours)
```

### **Account locked on first attempt**
```
Check:
1. Query: SELECT * FROM users WHERE email = 'test@example.com'
2. failed_login_attempts should be 0
3. locked_until should be NULL
4. Or manually reset: UPDATE users SET failed_login_attempts = 0, locked_until = NULL;
```

---

**Questions? Refer to the security guide in `/memories/session/auth_security_guide.md`**
