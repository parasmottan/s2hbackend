const mongoose = require('mongoose');
const { REQUEST_STATUS } = require('../config/constants');

const requestSchema = new mongoose.Schema(
  {
    seekerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    helperId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    category: {
      type: String,
      required: [true, 'Help category is required'],
      trim: true,
    },
    budget: {
      type: Number,
      required: [true, 'Budget is required'],
      min: [0, 'Budget must be a positive number'],
    },
    estimatedArrivalTime: {
      type: Number, // minutes
      required: [true, 'Estimated arrival time is required'],
      min: [1, 'Arrival time must be at least 1 minute'],
    },
    /**
     * GeoJSON Point — seeker's location at request time.
     * Used for geospatial queries to find nearby helpers.
     */
    seekerLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [lng, lat]
        required: true,
      },
    },
    /**
     * GeoJSON Point — helper's location when they accepted.
     */
    helperLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: [0, 0],
      },
    },
    status: {
      type: String,
      enum: Object.values(REQUEST_STATUS),
      default: REQUEST_STATUS.SEARCHING,
    },
    /**
     * The helper who locked (accepted) this request.
     * Used in the atomic findOneAndUpdate to prevent race conditions:
     *   filter: { _id, status: 'searching', lockedBy: null }
     * Only the first helper to match this filter wins.
     */
    lockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    timerStartedAt: {
      type: Date,
      default: null,
    },
    /**
     * When the request should auto-expire if still in 'searching' status.
     * Set on creation to `now + SEARCH_EXPIRY_MS`.
     */
    expiresAt: {
      type: Date,
      default: null,
    },
    /**
     * Timestamp when seeker confirmed the helper.
     */
    confirmedAt: {
      type: Date,
      default: null,
    },
    /**
     * End of the 5-minute cancellation/rejection window.
     * After this time, neither seeker nor helper can cancel.
     */
    cancelWindowExpiresAt: {
      type: Date,
      default: null,
    },
    /**
     * If helper rejected, the reason they provided.
     */
    rejectionReason: {
      type: String,
      default: null,
      trim: true,
    },
  },
  { timestamps: true }
);

// ── Indexes ─────────────────────────────────────────────────────
requestSchema.index({ seekerLocation: '2dsphere' });
requestSchema.index({ seekerId: 1, status: 1 });
requestSchema.index({ helperId: 1, status: 1 });
requestSchema.index({ expiresAt: 1 }); // for expiry queries

module.exports = mongoose.model('Request', requestSchema);
