const rateLimit = require('express-rate-limit');

/**
 * Rate limiter for the search endpoint.
 * Prevents a single IP from spamming search requests.
 *
 * Defaults: 10 requests per 1 minute window.
 */
const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many search requests from this IP. Please try again later.',
  },
});

module.exports = { searchLimiter };
