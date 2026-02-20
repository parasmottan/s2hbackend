const Request = require('../models/Request');
const { REQUEST_STATUS, DEFAULTS } = require('../config/constants');
const { findNearbyHelpers } = require('../utils/geospatial');
const AppError = require('../utils/AppError');

/**
 * POST /api/requests/search
 * Seeker creates a new help request via REST (fallback to socket).
 *
 * OVERRIDE LOGIC:
 *   1. Cancel all previous active requests atomically
 *   2. Create the new request with expiresAt
 *   3. Find nearby helpers
 *   4. Return the request
 */
exports.searchHelp = async (req, res, next) => {
  try {
    const { category, budget, estimatedArrivalTime, longitude, latitude } =
      req.body;

    // ── Override: cancel all previous active requests ────────────
    const activeStatuses = [
      REQUEST_STATUS.SEARCHING,
      REQUEST_STATUS.HELPER_ACCEPTED,
      REQUEST_STATUS.CONFIRMED,
    ];

    const cancelResult = await Request.updateMany(
      { seekerId: req.user._id, status: { $in: activeStatuses } },
      { status: REQUEST_STATUS.CANCELLED }
    );

    if (cancelResult.modifiedCount > 0) {
      console.log(`[REST] Cancelled ${cancelResult.modifiedCount} previous request(s) for ${req.user._id}`);
    }

    // ── Create request with expiry ──────────────────────────────
    const now = new Date();
    const helpRequest = await Request.create({
      seekerId: req.user._id,
      category,
      budget,
      estimatedArrivalTime,
      seekerLocation: {
        type: 'Point',
        coordinates: [longitude, latitude],
      },
      status: REQUEST_STATUS.SEARCHING,
      expiresAt: new Date(now.getTime() + DEFAULTS.SEARCH_EXPIRY_MS),
    });

    // ── Find nearby helpers ─────────────────────────────────────
    let nearbyHelpers = [];
    try {
      nearbyHelpers = await findNearbyHelpers(longitude, latitude);
    } catch (err) {
      console.error('[REST] Geo query error:', err.message);
    }

    res.status(201).json({
      success: true,
      data: {
        request: helpRequest,
        nearbyHelpers: nearbyHelpers.length,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/requests/:id
 * Fetch a single request — only the seeker or helper involved can view it.
 */
exports.getRequestById = async (req, res, next) => {
  try {
    const helpRequest = await Request.findById(req.params.id)
      .populate('seekerId', 'name email rating')
      .populate('helperId', 'name email rating currentLocation');

    if (!helpRequest) {
      return next(new AppError('Request not found', 404));
    }

    const userId = req.user._id.toString();
    const isSeeker = helpRequest.seekerId._id.toString() === userId;
    const isHelper =
      helpRequest.helperId &&
      helpRequest.helperId._id.toString() === userId;

    if (!isSeeker && !isHelper) {
      return next(new AppError('Not authorized to view this request', 403));
    }

    res.status(200).json({
      success: true,
      data: helpRequest,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/requests/:id/cancel
 * Seeker cancels their request.
 */
exports.cancelRequest = async (req, res, next) => {
  try {
    const helpRequest = await Request.findById(req.params.id);

    if (!helpRequest) {
      return next(new AppError('Request not found', 404));
    }

    if (helpRequest.seekerId.toString() !== req.user._id.toString()) {
      return next(new AppError('Not authorized to cancel this request', 403));
    }

    if (
      helpRequest.status === REQUEST_STATUS.COMPLETED ||
      helpRequest.status === REQUEST_STATUS.CANCELLED ||
      helpRequest.status === REQUEST_STATUS.EXPIRED
    ) {
      return next(
        new AppError(`Cannot cancel a ${helpRequest.status} request`, 400)
      );
    }

    helpRequest.status = REQUEST_STATUS.CANCELLED;
    await helpRequest.save();

    res.status(200).json({
      success: true,
      data: helpRequest,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/requests/my
 * Returns all requests for the authenticated user.
 * - Seekers see requests they created
 * - Helpers see requests they were assigned to
 */
exports.getMyRequests = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const role = req.user.role;

    let filter;
    if (role === 'helper') {
      filter = { helperId: userId };
    } else {
      filter = { seekerId: userId };
    }

    const requests = await Request.find(filter)
      .sort({ createdAt: -1 })
      .populate('seekerId', 'name email')
      .populate('helperId', 'name email rating')
      .limit(50);

    res.status(200).json({
      success: true,
      count: requests.length,
      data: requests,
    });
  } catch (err) {
    next(err);
  }
};
