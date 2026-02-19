const jwt = require('jsonwebtoken');
const { SOCKET_EVENTS } = require('../config/constants');
const registerHelperEvents = require('./helperEvents');
const registerSeekerEvents = require('./seekerEvents');
const onlineHelpers = require('../utils/onlineHelpers');
const User = require('../models/User');

/**
 * Initialise Socket.io on the given HTTP server.
 *
 * Responsibilities:
 *   1. JWT authentication middleware for every socket connection
 *   2. Join each user to a personal room `user:<id>`
 *   3. Delegate to role-specific event handlers
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
  });

  // ── Socket authentication middleware ──────────────────────────
  // Every connecting client must send a JWT in the `auth` handshake.
  // Example client-side:
  //   io('http://localhost:5000', { auth: { token: 'Bearer <jwt>' } })
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error('Authentication error — no token provided'));
      }

      // Strip "Bearer " prefix if present
      const cleanToken = token.startsWith('Bearer ')
        ? token.split(' ')[1]
        : token;

      const decoded = jwt.verify(cleanToken, process.env.JWT_SECRET);

      // Fetch user to get role
      const user = await User.findById(decoded.id).select('role');
      if (!user) {
        return next(new Error('Authentication error — user not found'));
      }

      // Attach to socket for downstream handlers
      socket.userId = decoded.id;
      socket.userRole = user.role;

      next();
    } catch (err) {
      next(new Error('Authentication error — invalid token'));
    }
  });

  // ── Connection handler ────────────────────────────────────────
  io.on(SOCKET_EVENTS.CONNECTION, (socket) => {
    const { userId, userRole } = socket;

    console.log(`⚡ Socket connected: ${userId} (${userRole}) — ${socket.id}`);

    // Join personal room for targeted server → client messages
    const roomName = `user:${userId}`;
    socket.join(roomName);
    console.log(`[Socket] ${userId} joined room: ${roomName}`);

    // Log all incoming events for debugging
    socket.onAny((event, ...args) => {
      console.log(`[Socket Incoming] ${userId} (${userRole}) emitted: ${event}`, args);
    });

    // Register role-specific event handlers
    // Register all handlers for flexibility (e.g. helper acting as seeker)
    registerHelperEvents(socket, io);
    registerSeekerEvents(socket, io);

    // Generic disconnect logging
    socket.on(SOCKET_EVENTS.DISCONNECT, () => {
      console.log(`💤 Socket disconnected: ${userId} — ${socket.id}`);
    });
  });

  return io;
};

module.exports = initSocket;
