const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AppError = require('../utils/AppError');

/**
 * Protect routes — verify JWT from Authorization header.
 * Attaches the full user document to `req.user`.
 */
const protect = async (req, res, next) => {
  try {
    let token;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer')
    ) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(new AppError('Not authorized — no token', 401));
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach user (exclude password)
    const user = await User.findById(decoded.id);
    if (!user) {
      return next(new AppError('User no longer exists', 401));
    }

    req.user = user;
    next();
  } catch (err) {
    return next(new AppError('Not authorized — token invalid', 401));
  }
};

/**
 * Role-based authorization.
 * Usage: authorize('seeker') or authorize('helper')
 * Must be used AFTER `protect`.
 */
const authorize = (...roles) => {
  return (req, _res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError(
          `Role '${req.user.role}' is not authorized for this route`,
          403
        )
      );
    }
    next();
  };
};

module.exports = { protect, authorize };
