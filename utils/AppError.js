/**
 * Custom operational error class.
 * Extends the built-in Error so the global error handler can
 * distinguish expected errors from unexpected programming bugs.
 */
class AppError extends Error {
  /**
   * @param {string} message  Human-readable message
   * @param {number} statusCode  HTTP status code (default 500)
   */
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true; // flag for the error handler

    // Capture clean stack trace (excludes constructor)
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
