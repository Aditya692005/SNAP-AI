// server.js
//
// Entry point. Run with: npm start  (or npm run dev to auto-restart on changes)

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const authRoutes = require("./src/routes/authRoutes");
const errorHandler = require("./src/middleware/errorHandler");
const { connectWithRetry } = require("./src/config/db");
const ragRoutes = require("./src/routes/ragRoutes");
const dashboardRoutes = require("./src/routes/dashboardRoutes");
const adminRoutes = require("./src/routes/adminRoutes");
const organizationRoutes = require("./src/routes/organizationRoutes");
const app = express();


// Security middleware — must come before routes
app.use(helmet()); // Sets secure HTTP headers
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true, // Allow credentials (cookies, auth headers)
  })
);
app.use(express.json({ limit: "10kb" })); // Limit payload size to prevent large attacks

// Simple health check — useful for confirming the server is up before
// debugging anything else.
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/api/auth", authRoutes);
app.use("/api/rag", ragRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/organization", organizationRoutes);
// 404 for anything that didn't match a route above
app.use((req, res) => {
  res.status(404).json({ message: "Not found." });
});

// Must be the LAST app.use() — catches errors passed via next(err)
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await connectWithRetry(); // retries a few times if MySQL isn't ready yet
    app.listen(PORT, () => {
      console.log(`SNAP AI backend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

start();
