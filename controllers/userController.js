const User = require('../models/User');
const AppError = require('../utils/AppError');

/**
 * PATCH /api/users/location
 * Update the authenticated user's GeoJSON location.
 */
exports.updateLocation = async (req, res, next) => {
  try {
    const { longitude, latitude } = req.body;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        currentLocation: {
          type: 'Point',
          coordinates: [longitude, latitude],
        },
      },
      { new: true, runValidators: true }
    ).select('-password');

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/users/profile
 * Return the authenticated user's profile.
 */
exports.getProfile = async (req, res, _next) => {
  res.status(200).json({
    success: true,
    data: req.user,
  });
};
