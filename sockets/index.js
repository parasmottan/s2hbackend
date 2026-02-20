const jwt = require('jsonwebtoken');
const { SOCKET_EVENTS, REQUEST_STATUS } = require('../config/constants');
const registerHelperEvents = require('./helperEvents');
const registerSeekerEvents = require('./seekerEvents');
const onlineHelpers = require('../utils/onlineHelpers');
const User = require('../models/User');
const Request = require('../models/Request');

const initSocket = (server) => {
  const { Server } = require('socket.io');

  const io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || "*", // SET FRONTEND_URL in production
      methods: ['GET', 'POST'],
      credentials: true
    },
    transports: ["websocket", "polling"],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // 🔥 Debug low-level engine errors
  io.engine.on("connection_error", (err) => {
    console.log("❌ Engine connection error:", err.message);
  });

  // ── Socket authentication middleware ──────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

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

      socket.userId = decoded.id;
      socket.userRole = user.role;
      socket.userName = user.name;

      next();
    } catch (err) {
      console.log("❌ Socket auth failed:", err.message);
      next(new Error('Authentication error — invalid token'));
    }
  });

  // ── Connection handler ────────────────────────────────────────
  io.on('connection', async (socket) => {
    const { userId, userRole } = socket;

    console.log(`⚡ Socket connected: ${userId} (${userRole}) — ${socket.id}`);

    socket.join(`user:${userId}`);

    // ── Auto-register helper ───────────────────────────────
    if (userRole === 'helper') {
      try {
        const user = await User.findById(userId).select('currentLocation');
        const coords = user?.currentLocation?.coordinates || [0, 0];

        onlineHelpers.setOnline(userId, socket.id, coords[0], coords[1]);
        await User.findByIdAndUpdate(userId, { isOnline: true });

        console.log(`🟢 Helper ${userId} registered online`);
      } catch (err) {
        console.log("Helper auto-register error:", err.message);
      }
    }

    // ── Sync state ─────────────────────────────────────────
    try {
      const activeStatuses = [
        REQUEST_STATUS.SEARCHING,
        REQUEST_STATUS.HELPER_ACCEPTED,
        REQUEST_STATUS.CONFIRMED,
        REQUEST_STATUS.ON_THE_WAY,
      ];

      let activeRequest = null;

      if (userRole === 'seeker' || userRole === 'helper') {
        const filter =
          userRole === 'seeker'
            ? { seekerId: userId, status: { $in: activeStatuses } }
            : { helperId: userId, status: { $in: activeStatuses } };

        activeRequest = await Request.findOne(filter)
          .sort({ createdAt: -1 })
          .populate('seekerId', 'name email')
          .populate('helperId', 'name email rating currentLocation');
      }

      socket.emit(SOCKET_EVENTS.SYNC_STATE, {
        activeRequest: activeRequest || null,
        onlineHelpers:
          userRole === 'helper' ? onlineHelpers.count() : undefined,
      });

      console.log(`[Sync] Sent to ${userId}`);
    } catch (err) {
      console.error(`[Sync] Error:`, err.message);
    }

    registerHelperEvents(socket, io);
    registerSeekerEvents(socket, io);

    // ── Disconnect cleanup ─────────────────────────────────
    socket.on('disconnect', async (reason) => {
      console.log(`🔴 Socket disconnected: ${userId} — ${reason}`);

      if (userRole === 'helper') {
        const removedId = onlineHelpers.removeBySocketId(socket.id);

        if (removedId) {
          await User.findByIdAndUpdate(removedId, { isOnline: false });
          console.log(`Helper ${removedId} removed from map`);
        }
      }
    });
  });

  return io;
};

module.exports = initSocket;
