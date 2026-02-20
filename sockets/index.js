const jwt = require('jsonwebtoken');
const { SOCKET_EVENTS, REQUEST_STATUS } = require('../config/constants');
const registerHelperEvents = require('./helperEvents');
const registerSeekerEvents = require('./seekerEvents');
const onlineHelpers = require('../utils/onlineHelpers');
const User = require('../models/User');
const Request = require('../models/Request');

/**
 * Initialise Socket.io on the given HTTP server.
 *
 * Responsibilities:
 *   1. JWT authentication middleware for every socket connection
 *   2. Join each user to a personal room `user:<id>`
 *   3. Auto-register helpers in onlineHelpers map on connect
 *   4. Push sync_state to reconnecting users
 *   5. Delegate to role-specific event handlers
 *   6. Clean up stale socket mappings on disconnect
 *
 * @param {import('http').Server} server
 * @returns {import('socket.io').Server}
 */
const initSocket = (server) => {
  const { Server } = require('socket.io');

  const io = new Server(server, {
    cors: {
      origin: '*', // tighten in production
      methods: ['GET', 'POST'],
    },
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  // ── Socket authentication middleware ──────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error('Authentication error — no token provided'));
      }

      const cleanToken = token.startsWith('Bearer ')
        ? token.split(' ')[1]
        : token;

      const decoded = jwt.verify(cleanToken, process.env.JWT_SECRET);

      const user = await User.findById(decoded.id).select('role name');
      if (!user) {
        return next(new Error('Authentication error — user not found'));
      }

      // Attach to socket for downstream handlers
      socket.userId = decoded.id;
      socket.userRole = user.role;
      socket.userName = user.name;

      next();
    } catch (err) {
      next(new Error('Authentication error — invalid token'));
    }
  });

  // ── Connection handler ────────────────────────────────────────
  io.on(SOCKET_EVENTS.CONNECTION, async (socket) => {
    const { userId, userRole } = socket;

    console.log(`⚡ Socket connected: ${userId} (${userRole}) — ${socket.id}`);

    // Join personal room for targeted server → client messages
    const roomName = `user:${userId}`;
    socket.join(roomName);

    // ── Auto-register helper in onlineHelpers map ───────────────
    // This ensures reconnecting helpers get a fresh socketId mapping
    // immediately, fixing stale socket bugs.
    if (userRole === 'helper') {
      const user = await User.findById(userId).select('currentLocation');
      const coords = user?.currentLocation?.coordinates || [0, 0];
      onlineHelpers.setOnline(userId, socket.id, coords[0], coords[1]);

      // Sync DB isOnline flag
      await User.findByIdAndUpdate(userId, { isOnline: true });
      console.log(`🟢 Helper ${userId} auto-registered in onlineHelpers map (reconnect-safe)`);
    }

    // ── Sync state for reconnecting users ───────────────────────
    // Push the latest active request status so the client knows
    // where to resume (fixes inconsistent reconnect behavior).
    try {
      const activeStatuses = [
        REQUEST_STATUS.SEARCHING,
        REQUEST_STATUS.HELPER_ACCEPTED,
        REQUEST_STATUS.CONFIRMED,
        REQUEST_STATUS.ON_THE_WAY,
      ];

      let activeRequest = null;

      if (userRole === 'seeker' || userRole === 'helper') {
        const filter = userRole === 'seeker'
          ? { seekerId: userId, status: { $in: activeStatuses } }
          : { helperId: userId, status: { $in: activeStatuses } };

        activeRequest = await Request.findOne(filter)
          .sort({ createdAt: -1 })
          .populate('seekerId', 'name email')
          .populate('helperId', 'name email rating currentLocation');
      }

      socket.emit(SOCKET_EVENTS.SYNC_STATE, {
        activeRequest: activeRequest || null,
        onlineHelpers: userRole === 'helper' ? onlineHelpers.count() : undefined,
      });

      console.log(`[Sync] Sent sync_state to ${userId}: ${activeRequest ? activeRequest.status : 'no active request'}`);
    } catch (err) {
      console.error(`[Sync] Error syncing state for ${userId}:`, err.message);
    }

    // Register event handlers (role-agnostic — both register, guards inside)
    registerHelperEvents(socket, io);
    registerSeekerEvents(socket, io);

    // ── Disconnect cleanup ──────────────────────────────────────
    socket.on(SOCKET_EVENTS.DISCONNECT, async () => {
      console.log(`💤 Socket disconnected: ${userId} (${userRole}) — ${socket.id}`);

      // Clean up helper from in-memory map using socketId
      // This handles the case correctly even if the same helper
      // reconnected on a different socket before this fires.
      if (userRole === 'helper') {
        const removedId = onlineHelpers.removeBySocketId(socket.id);
        if (removedId) {
          await User.findByIdAndUpdate(removedId, { isOnline: false });
          console.log(`🔴 Helper ${removedId} removed from onlineHelpers (socket ${socket.id})`);
        }
      }
    });
  });

  return io;
};

module.exports = initSocket;
