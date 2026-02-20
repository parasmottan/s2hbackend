const Request = require('../models/Request');
const { REQUEST_STATUS, SOCKET_EVENTS } = require('../config/constants');

/**
 * Active timers keyed by requestId so we can clear them on
 * cancellation or completion.
 * @type {Map<string, NodeJS.Timeout>}
 */
const activeTimers = new Map();

/**
 * Search expiry timers keyed by requestId.
 * @type {Map<string, NodeJS.Timeout>}
 */
const searchTimers = new Map();

// ─── Arrival Timer ──────────────────────────────────────────────

/**
 * Start an arrival countdown timer for a confirmed request.
 *
 * 1. Emits `arrival_timer_started` immediately to both parties.
 * 2. When the timer expires, sets the request status to `completed`
 *    and emits `request_expired`.
 *
 * @param {string} requestId  The Mongoose ObjectId string
 * @param {number} durationMs Timer duration in milliseconds
 * @param {import('socket.io').Server} io  Socket.io server instance
 * @param {string} roomName   The private room name
 */
const startArrivalTimer = (requestId, durationMs, io, roomName) => {
  // Clear any existing timer for this request
  clearArrivalTimer(requestId);

  // Emit start event to the private room
  io.to(roomName).emit(SOCKET_EVENTS.ARRIVAL_TIMER_STARTED, {
    requestId,
    durationMs,
    startedAt: new Date().toISOString(),
  });

  // Set the countdown
  const handle = setTimeout(async () => {
    try {
      await Request.findByIdAndUpdate(requestId, {
        status: REQUEST_STATUS.COMPLETED,
      });

      io.to(roomName).emit(SOCKET_EVENTS.REQUEST_EXPIRED, {
        requestId,
        message: 'Arrival timer expired — request marked completed.',
      });
    } catch (err) {
      console.error('Timer expiry error:', err.message);
    } finally {
      activeTimers.delete(requestId);
    }
  }, durationMs);

  activeTimers.set(requestId, handle);
};

/**
 * Cancel an active arrival timer.
 * @param {string} requestId
 */
const clearArrivalTimer = (requestId) => {
  const handle = activeTimers.get(requestId);
  if (handle) {
    clearTimeout(handle);
    activeTimers.delete(requestId);
  }
};

// ─── Search Expiry Timer ────────────────────────────────────────

/**
 * Start a search expiry timer.
 * If the request is still in 'searching' status when it fires,
 * mark it as 'expired' and notify the seeker.
 *
 * @param {string} requestId
 * @param {number} durationMs  How long to wait before expiring
 * @param {import('socket.io').Server} io
 * @param {string} seekerUserId  The seeker's userId for room targeting
 */
const startSearchExpiry = (requestId, durationMs, io, seekerUserId) => {
  // Clear any previous search timer for this request
  clearSearchExpiry(requestId);

  const handle = setTimeout(async () => {
    try {
      // Atomically expire ONLY if still in 'searching' status
      const expired = await Request.findOneAndUpdate(
        { _id: requestId, status: REQUEST_STATUS.SEARCHING },
        { status: REQUEST_STATUS.EXPIRED },
        { new: true }
      );

      if (expired) {
        const seekerRoom = `user:${seekerUserId}`;
        io.to(seekerRoom).emit(SOCKET_EVENTS.REQUEST_EXPIRED, {
          requestId,
          message: 'No helper responded in time. Please try again.',
        });
        console.log(`⏰ Request ${requestId} expired (no helper accepted in ${durationMs}ms)`);
      }
      // If null → request was already accepted/cancelled/etc, nothing to do
    } catch (err) {
      console.error('Search expiry error:', err.message);
    } finally {
      searchTimers.delete(requestId);
    }
  }, durationMs);

  searchTimers.set(requestId, handle);
};

/**
 * Cancel a search expiry timer (e.g. when a helper accepts).
 * @param {string} requestId
 */
const clearSearchExpiry = (requestId) => {
  const handle = searchTimers.get(requestId);
  if (handle) {
    clearTimeout(handle);
    searchTimers.delete(requestId);
  }
};

module.exports = {
  startArrivalTimer,
  clearArrivalTimer,
  startSearchExpiry,
  clearSearchExpiry,
};
