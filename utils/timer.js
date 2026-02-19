const Request = require('../models/Request');
const { REQUEST_STATUS, SOCKET_EVENTS } = require('../config/constants');

/**
 * Active timers keyed by requestId so we can clear them on
 * cancellation or completion.
 * @type {Map<string, NodeJS.Timeout>}
 */
const activeTimers = new Map();

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
 * Cancel an active timer (e.g. on manual cancellation or early completion).
 * @param {string} requestId
 */
const clearArrivalTimer = (requestId) => {
  const handle = activeTimers.get(requestId);
  if (handle) {
    clearTimeout(handle);
    activeTimers.delete(requestId);
  }
};

module.exports = { startArrivalTimer, clearArrivalTimer };
