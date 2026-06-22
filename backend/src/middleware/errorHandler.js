// src/middleware/errorHandler.js
//
// Every controller calls next(err) instead of handling errors inline.
// This is the one place that turns an error into a JSON response.
//
// Operational errors (AppError, e.g. "wrong password", "email taken")
// keep their intended status code and message. Anything unexpected
// (a bug, a dropped DB connection, etc.) is logged and returned as a
// generic 500 so internal details never leak to the client — and 500s
// are exactly what the frontend's apiClient.js treats as retryable.

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const isOperational = err.isOperational === true;
  const statusCode = isOperational ? err.statusCode : 500;
  const message = isOperational ? err.message : "Something went wrong on our end. Please try again.";

  if (!isOperational) {
    console.error(err);
  }

  res.status(statusCode).json({ message });
}

module.exports = errorHandler;
