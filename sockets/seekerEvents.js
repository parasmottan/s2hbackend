const Request = require('../models/Request');
const User = require('../models/User');
const { REQUEST_STATUS, SOCKET_EVENTS, DEFAULTS } = require('../config/constants');
const { findNearbyHelpers } = require('../utils/geospatial');
const { startArrivalTimer, clearArrivalTimer, startSearchExpiry, clearSearchExpiry } = require('../utils/timer');
const onlineHelpers = require('../utils/onlineHelpers');

/**
 * Register seeker-side socket events.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 */
module.exports = (socket, io) => {
  const userId = socket.userId;

  // ── search_help ───────────────────────────────────────────────
  // Seeker triggers a real-time search for nearby helpers.
  //
  // OVERRIDE LOGIC:
  //   1. Cancel ALL previous active requests for this seeker (atomic)
  //   2. Notify affected helpers that their request was cancelled
  //   3. Create the new request
  //   4. Emit to online helpers via in-memory map (NOT DB query)
  //   5. Start search expiry timer
  socket.on(SOCKET_EVENTS.SEARCH_HELP, async (data) => {
    console.log(`[SeekerEvents] 🔍 search_help RECEIVED from ${userId} (Socket: ${socket.id})`, data);
    try {
      const { category, budget, estimatedArrivalTime, longitude, latitude } = data;

      // ── STEP 1: Strict Search Guard (Cancel active requests) ─────
      const activeStatuses = [
        REQUEST_STATUS.SEARCHING,
        REQUEST_STATUS.HELPER_ACCEPTED,
        REQUEST_STATUS.CONFIRMED,
      ];

      const activeRequests = await Request.find({
        seekerId: userId,
        status: { $in: activeStatuses },
      }).select('_id helperId status');

      if (activeRequests.length > 0) {
        // Atomic cancel all previous
        await Request.updateMany(
          { seekerId: userId, status: { $in: activeStatuses } },
          { status: REQUEST_STATUS.CANCELLED }
        );

        for (const req of activeRequests) {
          clearSearchExpiry(req._id.toString());
          clearArrivalTimer(req._id.toString());

          if (req.helperId) {
            io.to(`user:${req.helperId.toString()}`).emit(SOCKET_EVENTS.REQUEST_CANCELLED, {
              requestId: req._id,
              message: 'Seeker started a new search. Previous request cancelled.',
            });
          }
        }
        console.log(`[SeekerEvents] 🧹 Cleaned ${activeRequests.length} active requests for ${userId}`);
      }

      // ── STEP 2: Create new request ─────────────────────────────
      const now = new Date();
      const expiresAt = new Date(now.getTime() + DEFAULTS.SEARCH_EXPIRY_MS);

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
        expiresAt,
      });

      console.log(`[SeekerEvents] 📝 Request CREATED: ${helpRequest._id} for seeker ${userId}`);

      // ── STEP 3: Deduplicate Helpers ───────────────────────────
      const allOnlineIds = onlineHelpers.getAllOnlineIds();
      let targetHelperIds = [];

      if (allOnlineIds.length > 0) {
        try {
          const geoHelpers = await findNearbyHelpers(longitude, latitude);
          targetHelperIds = geoHelpers
            .map((h) => h._id.toString())
            .filter((id) => onlineHelpers.isOnline(id));
        } catch (geoErr) {
          console.error(`[SeekerEvents] Geo query failed: ${geoErr.message}`);
        }

        if (targetHelperIds.length === 0) {
          targetHelperIds = allOnlineIds;
        }
      }

      // 🔥 CRITICAL FIX: Deduplicate using a Set
      const uniqueHelperIds = [...new Set(targetHelperIds)];
      const uniqueSocketIds = new Set(); // Also track socket IDs to prevent double-emit to same connection

      if (uniqueHelperIds.length === 0) {
        helpRequest.status = REQUEST_STATUS.EXPIRED;
        await helpRequest.save();

        socket.emit(SOCKET_EVENTS.REQUEST_EXPIRED, {
          requestId: helpRequest._id,
          message: 'No helpers are available right now. Please try again later.',
        });
        return;
      }

      // ── STEP 4: Emit new_request with deduplication ───────────
      let notifiedCount = 0;
      for (const helperId of uniqueHelperIds) {
        const socketId = onlineHelpers.getSocketId(helperId);
        if (!socketId || uniqueSocketIds.has(socketId)) continue;

        const helperSocket = io.sockets.sockets.get(socketId);
        if (!helperSocket) {
          onlineHelpers.removeBySocketId(socketId);
          continue;
        }

        uniqueSocketIds.add(socketId);
        helperSocket.emit(SOCKET_EVENTS.NEW_REQUEST, {
          requestId: helpRequest._id,
          category,
          budget,
          estimatedArrivalTime,
          seekerLocation: helpRequest.seekerLocation,
        });
        notifiedCount++;
      }

      startSearchExpiry(helpRequest._id.toString(), DEFAULTS.SEARCH_EXPIRY_MS, io, userId);

      socket.emit('search_started', {
        requestId: helpRequest._id,
        helpersNotified: notifiedCount,
      });

      console.log(`[SeekerEvents] 📡 BROADCAST for ${helpRequest._id}: ${notifiedCount} helpers notified`);
    } catch (err) {
      console.error(`[SeekerEvents] ❌ search_help error:`, err);
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });

  // ── confirm_helper ────────────────────────────────────────────
  // After seeing helper info, the seeker confirms.
  // This triggers:
  //   1. Status → confirmed → on_the_way
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

      // ── Update status + set cancel window ───────────────────────
      const now = new Date();
      const cancelWindowExpiresAt = new Date(now.getTime() + DEFAULTS.CANCEL_WINDOW_MS);

      helpRequest.status = REQUEST_STATUS.CONFIRMED;
      helpRequest.timerStartedAt = now;
      helpRequest.confirmedAt = now;
      helpRequest.cancelWindowExpiresAt = cancelWindowExpiresAt;
      await helpRequest.save();

      // ── Create private room ───────────────────────────────────
      const privateRoom = `request:${requestId}`;
      socket.join(privateRoom);

      // Join helper to the room (if connected)
      const helperSocketId = onlineHelpers.getSocketId(helpRequest.helperId.toString());
      if (helperSocketId) {
        const helperSocket = io.sockets.sockets.get(helperSocketId);
        if (helperSocket) {
          helperSocket.join(privateRoom);
        }
      }

      // ── Notify helper to start heading to seeker ──────────────
      io.to(`user:${helpRequest.helperId.toString()}`).emit(SOCKET_EVENTS.HELPER_ON_THE_WAY, {
        requestId,
        seekerLocation: helpRequest.seekerLocation,
        message: 'Seeker confirmed! Head to the location.',
      });

      // Update to on_the_way
      helpRequest.status = REQUEST_STATUS.ON_THE_WAY;
      await helpRequest.save();

      // ── Emit confirm_redirect to BOTH seeker and helper ───────
      const redirectPayload = {
        requestId,
        cancelWindowExpiresAt: cancelWindowExpiresAt.toISOString(),
        seekerLocation: helpRequest.seekerLocation,
        helperLocation: helpRequest.helperLocation,
      };

      // To seeker (this socket)
      socket.emit(SOCKET_EVENTS.CONFIRM_REDIRECT, redirectPayload);

      // To helper
      io.to(`user:${helpRequest.helperId.toString()}`).emit(SOCKET_EVENTS.CONFIRM_REDIRECT, redirectPayload);

      // ── Start arrival timer ───────────────────────────────────
      const durationMs = helpRequest.estimatedArrivalTime * 60 * 1000;
      startArrivalTimer(requestId, durationMs, io, privateRoom);

      // ── Schedule cancel window expiry ──────────────────────────
      setTimeout(() => {
        io.to(privateRoom).emit(SOCKET_EVENTS.CANCEL_WINDOW_EXPIRED, {
          requestId,
          message: 'Cancellation window has expired. Request cannot be cancelled.',
        });
        console.log(`🔒 Cancel window expired for request ${requestId}`);
      }, DEFAULTS.CANCEL_WINDOW_MS);

      console.log(`✅ Request ${requestId} confirmed — helper en route, cancel window ${DEFAULTS.CANCEL_WINDOW_MS / 1000}s`);
    } catch (err) {
      console.error(`[SeekerEvents] confirm_helper error:`, err);
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
        helpRequest.status === REQUEST_STATUS.CANCELLED ||
        helpRequest.status === REQUEST_STATUS.EXPIRED
      ) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: `Cannot cancel a ${helpRequest.status} request.`,
        });
        return;
      }

      // ── Cancel window guard ────────────────────────────────────
      if (helpRequest.cancelWindowExpiresAt && new Date() > helpRequest.cancelWindowExpiresAt) {
        socket.emit(SOCKET_EVENTS.ERROR, {
          message: 'Cancellation window has expired. You can no longer cancel this request.',
        });
        return;
      }

      helpRequest.status = REQUEST_STATUS.CANCELLED;
      await helpRequest.save();

      // Clear all timers
      clearArrivalTimer(requestId);
      clearSearchExpiry(requestId);

      // Notify helper if one was assigned
      if (helpRequest.helperId) {
        io.to(`user:${helpRequest.helperId.toString()}`).emit(SOCKET_EVENTS.REQUEST_CANCELLED, {
          requestId,
          message: 'The seeker has cancelled the request.',
        });
      }

      socket.emit(SOCKET_EVENTS.REQUEST_CANCELLED, {
        requestId,
        message: 'Request cancelled successfully.',
      });

      console.log(`❌ Request ${requestId} cancelled by seeker ${userId}`);
    } catch (err) {
      console.error(`[SeekerEvents] cancel_request error:`, err);
      socket.emit(SOCKET_EVENTS.ERROR, { message: err.message });
    }
  });
};
