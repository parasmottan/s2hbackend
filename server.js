require('dotenv').config();

const http = require('http');
const app = require('./app');
const connectDB = require('./config/db');
const initSocket = require('./sockets');

const PORT = process.env.PORT || 5000;

// ── Create HTTP server (required for Socket.io) ─────────────────
const server = http.createServer(app);

// ── Attach Socket.io ────────────────────────────────────────────
const io = initSocket(server);

// Make io accessible from controllers if needed
app.set('io', io);

// ── Connect to MongoDB, then start listening ────────────────────
connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
});

// ── Graceful shutdown ───────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION 💥:', err.message);
  server.close(() => process.exit(1));
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  server.close(() => process.exit(0));
});
