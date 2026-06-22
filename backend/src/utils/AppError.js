// src/utils/AppError.js
//
// Throw `new AppError("message", 400)` from anywhere in a controller and
// the central error handler in middleware/errorHandler.js will turn it
// into the right JSON response with the right HTTP status.

class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true; // distinguishes expected errors from bugs
  }
}

module.exports = AppError;
