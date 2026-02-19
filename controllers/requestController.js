const Request = require('../models/Request');
const { REQUEST_STATUS } = require('../config/constants');
const { findNearbyHelpers } = require('../utils/geospatial');
const AppError = require('../utils/AppError');

/**
 * POST /api/requests/search
 * Seeker creates a new help request.
 *
 * Flow:
 *   1. Prevent duplicate active requests from the same seeker
 *   2. Create the request with status 'searching'
 *   3. Find nearby online helpers (geospatial)
 *   4. Return the request + nearby helpers list
 *
 * Real-time notification to helpers is handled in the socket layer;
 * this controller is the REST fallback / initial create.
 */
exports.searchHelp = async (req, res, next) => {
  try {
    const { category, budget, estimatedArrivalTime, longitude, latitude } =
      req.body;

    // ── Guard: prevent duplicate active requests ────────────────
    const activeRequest = await Request.findOne({
      seekerId: req.user._id,
      status: {
        $in: [
          REQUEST_STATUS.SEARCHING,
          REQUEST_STATUS.HELPER_ACCEPTED,
          REQUEST_STATUS.CONFIRMED,
          REQUEST_STATUS.ON_THE_WAY,
        ],
      },
    });

    if (activeRequest) {
      return next(
        new AppError(
          'You already have an active request. Cancel it before creating a new one.',
          400
        )
      );
    }

    // ── Create request ──────────────────────────────────────────
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
    });

    // ── Find nearby helpers ─────────────────────────────────────
    const nearbyHelpers = await findNearbyHelpers(longitude, latitude);

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

    // Only allow involved parties to view
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

    // Can only cancel non-completed requests
    if (
      helpRequest.status === REQUEST_STATUS.COMPLETED ||
      helpRequest.status === REQUEST_STATUS.CANCELLED
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
