const User = require('../models/User');
const Request = require('../models/Request');
const { REQUEST_STATUS, SOCKET_EVENTS } = require('../config/constants');
const onlineHelpers = require('../utils/onlineHelpers');
const { clearSearchExpiry } = require('../utils/timer');

/**
 * Register helper-side socket events.
 *
 * NOTE: Disconnect cleanup is handled in sockets/index.js
 * using removeBySocketId() — do NOT add a duplicate here.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 */
module.exports = (socket, io) => {
  const userId = socket.userId;

  // ── go_online ─────────────────────────────────────────────────
  socket.on(SOCKET_EVENTS.GO_ONLINE, async (data) => {
    try {
      // Only helpers can go online
      if (socket.userRole !== 'helper') {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Only helpers can go online.' });
        return;
      }

      const { longitude, latitude } = data;
      const lng = longitude || 0;
      const lat = latitude || 0;

      // Update DB — set isOnline + location
      await User.findByIdAndUpdate(userId, {
        isOnline: true,
        currentLocation: {
          type: 'Point',
          coordinates: [lng, lat],
        },
      });

      // Update in-memory map with socketId + location
      onlineHelpers.setOnline(userId, socket.id, lng, lat);

      socket.emit('status', { online: true });
      console.log(`🟢 Helper ${userId} is online at [${lng}, ${lat}] (socket: ${socket.id})`);
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
      console.log(`🔴 Helper ${userId} went offline`);
    } catch (err) {
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });

  // ── accept_request ────────────────────────────────────────────
  // ATOMIC LOCKING — only the first helper to match the filter wins.
  //
  // Filter: { _id, status: 'searching', lockedBy: null }
  // MongoDB guarantees that only ONE concurrent update succeeds
  // because the first write changes both fields.
  socket.on(SOCKET_EVENTS.ACCEPT_REQUEST, async (data) => {
    try {
      const { requestId } = data;

      const updatedRequest = await Request.findOneAndUpdate(
        {
          _id: requestId,
          status: REQUEST_STATUS.SEARCHING,
          lockedBy: null,
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
        socket.emit(SOCKET_EVENTS.REQUEST_LOCKED, {
          requestId,
          message: 'Request is no longer available (already accepted by another helper).',
          locked: true,
        });
        return;
      }

      // Cancel the search expiry timer — a helper accepted
      clearSearchExpiry(requestId);

      // Get helper info to send to the seeker
      const helper = await User.findById(userId).select('name email rating currentLocation');

      // Save helper's current location on the request
      updatedRequest.helperLocation = helper.currentLocation;
      await updatedRequest.save();

      // Notify seeker that a helper has accepted
      const seekerRoom = `user:${updatedRequest.seekerId.toString()}`;

      io.to(seekerRoom).emit(SOCKET_EVENTS.HELPER_FOUND, {
        requestId,
        helper: {
          _id: helper._id,
          name: helper.name,
          email: helper.email,
          rating: helper.rating,
          currentLocation: helper.currentLocation,
          longitude: helper.currentLocation?.coordinates?.[0],
          latitude: helper.currentLocation?.coordinates?.[1],
        },
      });

      // Notify helper that lock was successful
      socket.emit(SOCKET_EVENTS.REQUEST_LOCKED, {
        requestId,
        message: 'You have successfully accepted the request. Waiting for seeker confirmation.',
        locked: false,
      });

      console.log(`🔒 Request ${requestId} locked by helper ${userId}`);
    } catch (err) {
      console.error(`[HelperEvents] accept_request error:`, err);
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });

  // ── reject_request ────────────────────────────────────────────
  // Helper rejects an active request (within cancel window).
  // Requires a reason. Validates status + time window.
  socket.on(SOCKET_EVENTS.REJECT_REQUEST, async (data) => {
    try {
      const { requestId, reason } = data;

      if (!reason || reason.trim().length === 0) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'Rejection reason is required.',
        });
        return;
      }

      const helpRequest = await Request.findById(requestId);

      if (!helpRequest) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Request not found.' });
        return;
      }

      if (helpRequest.helperId?.toString() !== userId) {
        socket.emit(SOCKET_EVENTS.ERROR, { message: 'Not your request to reject.' });
        return;
      }

      // Status guard — can only reject confirmed/on_the_way
      if (
        helpRequest.status !== REQUEST_STATUS.CONFIRMED &&
        helpRequest.status !== REQUEST_STATUS.ON_THE_WAY
      ) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: `Cannot reject — current status is '${helpRequest.status}'.`,
        });
        return;
      }

      // Time guard — must be within cancel window
      if (helpRequest.cancelWindowExpiresAt && new Date() > helpRequest.cancelWindowExpiresAt) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'Rejection window has expired. You can no longer reject this request.',
        });
        return;
      }

      // ── Cancel the request with reason ────────────────────────
      helpRequest.status = REQUEST_STATUS.CANCELLED;
      helpRequest.rejectionReason = reason.trim();
      await helpRequest.save();

      // Notify seeker
      io.to(`user:${helpRequest.seekerId.toString()}`).emit(SOCKET_EVENTS.REQUEST_CANCELLED, {
        requestId,
        reason: reason.trim(),
        rejectedBy: 'helper',
        message: `Helper rejected the request: ${reason.trim()}`,
      });

      // Confirm to helper
      socket.emit(SOCKET_EVENTS.REQUEST_CANCELLED, {
        requestId,
        reason: reason.trim(),
        rejectedBy: 'helper',
        message: 'You have rejected this request.',
      });

      console.log(`🚫 Request ${requestId} rejected by helper ${userId}: "${reason.trim()}"`);
    } catch (err) {
      console.error(`[HelperEvents] reject_request error:`, err);
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });

  // Cache for throttling DB updates
  const lastDbUpdates = new Map();

  // ── location_update ───────────────────────────────────────────
  // Helper periodically sends their updated position (e.g., every 3s).
  // We forward to the seeker immediately via socket for smooth tracking,
  // but only update the DB every 20 seconds to prevent flooding.
  socket.on(SOCKET_EVENTS.LOCATION_UPDATE, async (data) => {
    try {
      const { requestId, longitude, latitude } = data;
      const now = Date.now();

      // Always update in-memory map (keeps discovery map fresh)
      onlineHelpers.updateLocation(userId, longitude, latitude);

      // Forward to private room immediately so seeker sees live movement
      if (requestId) {
        const roomName = `request:${requestId}`;
        io.to(roomName).emit(SOCKET_EVENTS.LOCATION_UPDATE, {
          helperId: userId,
          longitude,
          latitude,
          location: { type: 'Point', coordinates: [longitude, latitude] },
          updatedAt: new Date().toISOString(),
        });
      }

      // ── Throttled DB Update ──────────────────────────────────
      const lastUpdate = lastDbUpdates.get(userId) || 0;
      const THROTTLE_MS = 20000; // 20 seconds

      if (now - lastUpdate >= THROTTLE_MS) {
        await User.findByIdAndUpdate(userId, {
          currentLocation: {
            type: 'Point',
            coordinates: [longitude, latitude],
          },
        });
        lastDbUpdates.set(userId, now);
        console.log(`📡 Throttled DB Location Update for ${userId}`);
      }
    } catch (err) {
      console.error(`[HelperEvents] location_update error:`, err);
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });

  // NOTE: disconnect handler is in sockets/index.js (single source of truth)
};
