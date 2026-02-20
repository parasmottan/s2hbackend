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
    console.log(`[SeekerEvents] search_help from ${userId}:`, data);
    try {
      const { category, budget, estimatedArrivalTime, longitude, latitude } = data;

      // ── STEP 1: Cancel all previous active requests (override) ──
      const activeStatuses = [
        REQUEST_STATUS.SEARCHING,
        REQUEST_STATUS.HELPER_ACCEPTED,
        REQUEST_STATUS.CONFIRMED,
      ];

      // Find active requests BEFORE cancelling (to notify helpers)
      const activeRequests = await Request.find({
        seekerId: userId,
        status: { $in: activeStatuses },
      }).select('_id helperId status');

      if (activeRequests.length > 0) {
        // Atomic cancel all
        await Request.updateMany(
          { seekerId: userId, status: { $in: activeStatuses } },
          { status: REQUEST_STATUS.CANCELLED }
        );

        // Notify each affected helper
        for (const req of activeRequests) {
          // Clear any search expiry timer
          clearSearchExpiry(req._id.toString());
          clearArrivalTimer(req._id.toString());

          if (req.helperId) {
            const helperSocketId = onlineHelpers.getSocketId(req.helperId.toString());
            if (helperSocketId) {
              io.to(`user:${req.helperId.toString()}`).emit(SOCKET_EVENTS.REQUEST_CANCELLED, {
                requestId: req._id,
                message: 'Seeker started a new search. Previous request cancelled.',
              });
            }
          }
        }

        console.log(`[SeekerEvents] Cancelled ${activeRequests.length} previous active request(s) for ${userId}`);
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

      // ── STEP 3: Find eligible online helpers ───────────────────
      // Primary: use in-memory map + optional geo filter
      // The in-memory map is the source of truth for who is online.
      const allOnlineIds = onlineHelpers.getAllOnlineIds();

      let targetHelperIds = [];

      if (allOnlineIds.length > 0) {
        // Try geo-filtered query first (only among actually-online helpers)
        try {
          const geoHelpers = await findNearbyHelpers(longitude, latitude);
          // Filter to only those actually in our in-memory map
          targetHelperIds = geoHelpers
            .map((h) => h._id.toString())
            .filter((id) => onlineHelpers.isOnline(id));
        } catch (geoErr) {
          console.error(`[SeekerEvents] Geo query failed: ${geoErr.message}`);
        }

        // Fallback: if geo returned nothing, use all online helpers
        if (targetHelperIds.length === 0) {
          targetHelperIds = allOnlineIds;
          console.log(`[SeekerEvents] Geo fallback: using all ${targetHelperIds.length} online helpers`);
        }
      }

      if (targetHelperIds.length === 0) {
        // No helpers online at all — expire the request immediately
        helpRequest.status = REQUEST_STATUS.EXPIRED;
        await helpRequest.save();

        socket.emit(SOCKET_EVENTS.REQUEST_EXPIRED, {
          requestId: helpRequest._id,
          message: 'No helpers are available right now. Please try again later.',
        });
        return;
      }

      // ── STEP 4: Emit new_request to each online helper ─────────
      let notified = 0;
      for (const helperId of targetHelperIds) {
        const socketId = onlineHelpers.getSocketId(helperId);
        if (!socketId) continue;

        // Verify socket is actually connected before emitting
        const helperSocket = io.sockets.sockets.get(socketId);
        if (!helperSocket) {
          // Stale mapping — clean it up
          onlineHelpers.removeBySocketId(socketId);
          console.log(`[SeekerEvents] Cleaned stale socket for helper ${helperId}`);
          continue;
        }

        helperSocket.emit(SOCKET_EVENTS.NEW_REQUEST, {
          requestId: helpRequest._id,
          category,
          budget,
          estimatedArrivalTime,
          seekerLocation: helpRequest.seekerLocation,
        });
        notified++;
      }

      // ── STEP 5: Start search expiry timer ──────────────────────
      startSearchExpiry(helpRequest._id.toString(), DEFAULTS.SEARCH_EXPIRY_MS, io, userId);

      // Acknowledge to seeker
      socket.emit('search_started', {
        requestId: helpRequest._id,
        helpersNotified: notified,
      });

      console.log(`🔍 Seeker ${userId} searching — ${notified} helpers notified (expiry in ${DEFAULTS.SEARCH_EXPIRY_MS / 1000}s)`);
    } catch (err) {
      console.error(`[SeekerEvents] search_help error:`, err);
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

      // ── Update status ─────────────────────────────────────────
      helpRequest.status = REQUEST_STATUS.CONFIRMED;
      helpRequest.timerStartedAt = new Date();
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

      // ── Start arrival timer ───────────────────────────────────
      const durationMs = helpRequest.estimatedArrivalTime * 60 * 1000;
      startArrivalTimer(requestId, durationMs, io, privateRoom);

      console.log(`✅ Request ${requestId} confirmed — helper en route, timer started`);
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
