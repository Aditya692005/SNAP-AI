// server.js
//
// Entry point. Run with: npm start  (or npm run dev to auto-restart on changes)

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const authRoutes = require("./src/routes/authRoutes");
const errorHandler = require("./src/middleware/errorHandler");
const { connectWithRetry } = require("./src/config/db");

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:5173" }));
app.use(express.json());

// Simple health check — useful for confirming the server is up before
// debugging anything else.
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/api/auth", authRoutes);

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
