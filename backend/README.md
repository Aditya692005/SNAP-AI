# SNAP AI Backend

Node.js + Express API backed by MySQL. Handles signup/login and issues a
JWT the frontend stores and sends back on future requests.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Create the database and table:
   ```
   mysql -u root -p < sql/schema.sql
   ```

3. Copy `.env.example` to `.env` and fill in your real MySQL credentials and
   a JWT secret (any long random string works):
   ```
   cp .env.example .env
   ```

4. Start the server:
   ```
   npm run dev
   ```

   You should see:
   ```
   Connected to MySQL.
   SNAP AI backend running on http://localhost:5000
   ```

## Endpoints

| Method | Path             | Auth required | Body                                  |
|--------|------------------|----------------|----------------------------------------|
| POST   | /api/auth/signup | No             | `{ name, email, password, role }`     |
| POST   | /api/auth/login  | No             | `{ email, password }`                 |
| GET    | /api/auth/me     | Yes (Bearer)   | —                                      |
| GET    | /health          | No             | —                                      |

Success responses return `{ token, user: { id, name, email, role } }`.
Errors return `{ message: "..." }` with an appropriate HTTP status
(400 = bad input, 401 = wrong credentials, 409 = email already registered,
500 = server/database problem).

This matches exactly what `frontend/src/services/authService.js` expects,
so no frontend changes are needed once this is running and `frontend/.env`
points `VITE_API_BASE_URL` at this server (default `http://localhost:5000`).
