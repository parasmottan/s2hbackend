const Request = require('../models/Request');
const User = require('../models/User');
const { REQUEST_STATUS, SOCKET_EVENTS, DEFAULTS } = require('../config/constants');
const { findNearbyHelpers } = require('../utils/geospatial');
const { startArrivalTimer, clearArrivalTimer } = require('../utils/timer');
const onlineHelpers = require('../utils/onlineHelpers');

/**
 * Register seeker-side socket events.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 */
module.exports = (socket, io) => {
  const userId = socket.userId; // set by auth middleware

  // ── search_help ───────────────────────────────────────────────
  // Seeker triggers a real-time search for nearby helpers.
  socket.on(SOCKET_EVENTS.SEARCH_HELP, async (data) => {
    console.log(`[SeekerEvents] Received search_help from ${userId}:`, data);
    try {
      const { category, budget, estimatedArrivalTime, longitude, latitude } = data;

      // ── Guard: prevent duplicate active requests ──────────────
      const existing = await Request.findOne({
        seekerId: userId,
        status: {
          $in: [
            REQUEST_STATUS.SEARCHING,
            REQUEST_STATUS.HELPER_ACCEPTED,
            REQUEST_STATUS.CONFIRMED,
            REQUEST_STATUS.ON_THE_WAY,
          ],
        },
      });

      if (existing) {
        console.log(`[SeekerEvents] Blocked active request for ${userId}: ${existing._id} (${existing.status})`);
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'You already have an active request.',
        });
        return;
      }

      // ── Create request ────────────────────────────────────────
      const helpRequest = await Request.create({
        seekerId: userId,
        category,
        budget,
        estimatedArrivalTime,
        seekerLocation: {
          type: 'Point',
          coordinates: [longitude, latitude],
        },
        status: REQUEST_STATUS.SEARCHING,
      });

      // ── Find nearby online helpers ────────────────────────────
      const nearbyHelpers = await findNearbyHelpers(longitude, latitude);

      if (nearbyHelpers.length === 0) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'No helpers are available nearby. Please try again later.',
        });
        return;
      }

      // ── Notify each nearby helper via their personal room ─────
      nearbyHelpers.forEach((helper) => {
        const helperRoom = `user:${helper._id.toString()}`;
        console.log(`[SeekerEvents] Notifying helper ${helper._id} in room ${helperRoom}`)
        io.to(helperRoom).emit(SOCKET_EVENTS.NEW_REQUEST, {
          requestId: helpRequest._id,
          category,
          budget,
          estimatedArrivalTime,
          seekerLocation: helpRequest.seekerLocation,
        });
      });

      // Acknowledge to seeker
      socket.emit('search_started', {
        requestId: helpRequest._id,
        helpersNotified: nearbyHelpers.length,
      });

      console.log(
        `🔍 Seeker ${userId} searching — ${nearbyHelpers.length} helpers notified`
      );
    } catch (err) {
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });

  // ── confirm_helper ────────────────────────────────────────────
  // After seeing helper info, the seeker confirms.
  // This triggers:
  //   1. Status → confirmed
  //   2. Private socket room creation
  //   3. Share seeker's live location with helper
  //   4. Start arrival countdown timer
  socket.on(SOCKET_EVENTS.CONFIRM_HELPER, async (data) => {
    try {
      const { requestId } = data;

      const helpRequest = await Request.findById(requestId);

      if (!helpRequest) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Request not found.' });
        return;
      }

      if (helpRequest.seekerId.toString() !== userId) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Not your request.' });
        return;
      }

      if (helpRequest.status !== REQUEST_STATUS.HELPER_ACCEPTED) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: `Cannot confirm — current status is '${helpRequest.status}'.`,
        });
        return;
      }

      // ── Update status ─────────────────────────────────────────
      helpRequest.status = REQUEST_STATUS.CONFIRMED;
      helpRequest.timerStartedAt = new Date();
      await helpRequest.save();

      // ── Create private room ───────────────────────────────────
      const roomName = `request:${requestId}`;

      // Join seeker to the room
      socket.join(roomName);

      // Join helper to the room (if they're connected)
      const helperSocketId = onlineHelpers.getSocketId(
        helpRequest.helperId.toString()
      );
      if (helperSocketId) {
        const helperSocket = io.sockets.sockets.get(helperSocketId);
        if (helperSocket) {
          helperSocket.join(roomName);
        }
      }

      // ── Share seeker location with helper ─────────────────────
      const helperRoom = `user:${helpRequest.helperId.toString()}`;
      io.to(helperRoom).emit(SOCKET_EVENTS.HELPER_ON_THE_WAY, {
        requestId,
        seekerLocation: helpRequest.seekerLocation,
        message: 'Seeker confirmed! Head to the location.',
      });

      // Update request status to on_the_way
      helpRequest.status = REQUEST_STATUS.ON_THE_WAY;
      await helpRequest.save();

      // ── Start arrival timer ───────────────────────────────────
      const durationMs =
        helpRequest.estimatedArrivalTime * 60 * 1000; // minutes → ms
      startArrivalTimer(requestId, durationMs, io, roomName);

      console.log(`✅ Request ${requestId} confirmed — timer started`);
    } catch (err) {
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });

  // ── cancel_request ────────────────────────────────────────────
  socket.on(SOCKET_EVENTS.CANCEL_REQUEST, async (data) => {
    try {
      const { requestId } = data;

      const helpRequest = await Request.findById(requestId);

      if (!helpRequest) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Request not found.' });
        return;
      }

      if (helpRequest.seekerId.toString() !== userId) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Not your request.' });
        return;
      }

      if (
        helpRequest.status === REQUEST_STATUS.COMPLETED ||
        helpRequest.status === REQUEST_STATUS.CANCELLED
      ) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: `Cannot cancel a ${helpRequest.status} request.`,
        });
        return;
      }

      helpRequest.status = REQUEST_STATUS.CANCELLED;
      await helpRequest.save();

      // Clear any active timer
      clearArrivalTimer(requestId);

      // Notify helper if one was assigned
      if (helpRequest.helperId) {
        const helperRoom = `user:${helpRequest.helperId.toString()}`;
        io.to(helperRoom).emit('request_cancelled', {
          requestId,
          message: 'The seeker has cancelled the request.',
        });
      }

      socket.emit('request_cancelled', {
        requestId,
        message: 'Request cancelled successfully.',
      });

      console.log(`❌ Request ${requestId} cancelled by seeker ${userId}`);
    } catch (err) {
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });
};
