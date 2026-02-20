const User = require('../models/User');
const AppError = require('../utils/AppError');

/**
 * GET /api/users/me
 * Returns the authenticated user's profile.
 */
exports.getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/users/role
 * Toggle the user's role between 'seeker' and 'helper'.
 */
exports.switchRole = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return next(new AppError('User not found', 404));

    user.role = user.role === 'seeker' ? 'helper' : 'seeker';
    await user.save();

    res.status(200).json({
      success: true,
      data: { _id: user._id, name: user.name, email: user.email, role: user.role, rating: user.rating },
    });
  } catch (err) {
    next(err);
  }
};
