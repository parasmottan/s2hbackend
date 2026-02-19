const User = require('../models/User');
const Request = require('../models/Request');
const { REQUEST_STATUS, SOCKET_EVENTS } = require('../config/constants');
const onlineHelpers = require('../utils/onlineHelpers');

/**
 * Register helper-side socket events.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 */
module.exports = (socket, io) => {
  const userId = socket.userId; // set by auth middleware

  // ── go_online ─────────────────────────────────────────────────
  socket.on(SOCKET_EVENTS.GO_ONLINE, async (data) => {
    try {
      const { longitude, latitude } = data;

      // Update DB
      await User.findByIdAndUpdate(userId, {
        isOnline: true,
        ...(longitude != null &&
          latitude != null && {
          currentLocation: {
            type: 'Point',
            coordinates: [longitude, latitude],
          },
        }),
      });

      // Update in-memory map
      onlineHelpers.setOnline(userId, socket.id);

      socket.emit('status', { online: true });
      console.log(`🟢 Helper ${userId} is online`);
    } catch (err) {
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });

  // ── go_offline ────────────────────────────────────────────────
  socket.on(SOCKET_EVENTS.GO_OFFLINE, async () => {
    try {
      await User.findByIdAndUpdate(userId, { isOnline: false });
      onlineHelpers.setOffline(userId);

      socket.emit('status', { online: false });
      console.log(`🔴 Helper ${userId} is offline`);
    } catch (err) {
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });

  // ── accept_request ────────────────────────────────────────────
  // CRITICAL: Atomic locking via findOneAndUpdate.
  //
  // The filter requires BOTH:
  //   status === 'searching'   AND   lockedBy === null
  //
  // MongoDB guarantees that only ONE update will match because
  // the first successful write changes both fields, so all
  // subsequent attempts by other helpers will fail the filter.
  // This eliminates race conditions without needing distributed locks.
  socket.on(SOCKET_EVENTS.ACCEPT_REQUEST, async (data) => {
    try {
      const { requestId } = data;

      const updatedRequest = await Request.findOneAndUpdate(
        {
          _id: requestId,
          status: REQUEST_STATUS.SEARCHING,
          lockedBy: null, // ← race-condition guard
        },
        {
          status: REQUEST_STATUS.HELPER_ACCEPTED,
          lockedBy: userId,
          helperId: userId,
        },
        { new: true }
      );

      // If null → another helper already locked it
      if (!updatedRequest) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'Request is no longer available (already accepted by another helper).',
        });
        return;
      }

      // Retrieve helper info to send to the seeker
      const helper = await User.findById(userId).select(
        'name email rating currentLocation'
      );

      // Save helper's current location on the request
      updatedRequest.helperLocation = helper.currentLocation;
      await updatedRequest.save();

      // Notify seeker that a helper has been found
      const seekerRoom = `user:${updatedRequest.seekerId.toString()}`;

      io.to(seekerRoom).emit(SOCKET_EVENTS.HELPER_FOUND, {
        requestId,
        helper: {
          _id: helper._id,
          name: helper.name,
          email: helper.email,
          rating: helper.rating,
          location: helper.currentLocation,
        },
      });

      // Notify helper that lock was successful
      socket.emit(SOCKET_EVENTS.REQUEST_LOCKED, {
        requestId,
        message: 'You have successfully accepted the request. Waiting for seeker confirmation.',
      });

      console.log(`🔒 Request ${requestId} locked by helper ${userId}`);
    } catch (err) {
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });

  // ── reject_request ────────────────────────────────────────────
  socket.on(SOCKET_EVENTS.REJECT_REQUEST, (data) => {
    // Simple acknowledgement — no state changes needed.
    // The request remains in 'searching' status for others.
    socket.emit('request_rejected_ack', {
      requestId: data.requestId,
      message: 'You have rejected this request.',
    });
  });

  // ── location_update ───────────────────────────────────────────
  // Helper periodically sends their updated position.
  // Forward it to the seeker via the private request room.
  socket.on(SOCKET_EVENTS.LOCATION_UPDATE, async (data) => {
    try {
      const { requestId, longitude, latitude } = data;

      // Persist in DB
      await User.findByIdAndUpdate(userId, {
        currentLocation: {
          type: 'Point',
          coordinates: [longitude, latitude],
        },
      });

      // Forward to private room so the seeker sees live position
      const roomName = `request:${requestId}`;
      io.to(roomName).emit(SOCKET_EVENTS.LOCATION_UPDATE, {
        helperId: userId,
        location: { type: 'Point', coordinates: [longitude, latitude] },
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });

  // ── disconnect ────────────────────────────────────────────────
  socket.on(SOCKET_EVENTS.DISCONNECT, async () => {
    try {
      // Mark offline in both DB and memory
      await User.findByIdAndUpdate(userId, { isOnline: false });
      onlineHelpers.setOffline(userId);
      console.log(`🔴 Helper ${userId} disconnected`);
    } catch (err) {
      console.error('Disconnect cleanup error:', err.message);
    }
  });
};
