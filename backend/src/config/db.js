// src/config/db.js
//
// MySQL connection pool, shared across the app. Also exports
// connectWithRetry(), called once at startup, which retries the initial
// connection a few times before giving up — useful if MySQL is still
// starting up (e.g. in Docker) when this server boots.

const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "snap_ai",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(maxRetries = 5, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const connection = await pool.getConnection();
      connection.release();
      console.log("Connected to MySQL.");
      return;
    } catch (err) {
      console.error(
        `MySQL connection attempt ${attempt}/${maxRetries} failed: ${err.message}`,
      );
      if (attempt === maxRetries) {
        throw new Error(
          "Could not connect to MySQL after multiple attempts. " +
            "Check DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME in your .env.",
        );
      }
      await sleep(delayMs * attempt); // back off a little more each try
    }
  }
}

module.exports = { pool, connectWithRetry };
