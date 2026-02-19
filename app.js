const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

// Route imports
const authRoutes = require('./routes/authRoutes');
const requestRoutes = require('./routes/requestRoutes');
const userRoutes = require('./routes/userRoutes');


const errorHandler = require('./middlewares/errorHandler');

const app = express();

// ── Global middleware ───────────────────────────────────────────
app.use(helmet()); // security headers
app.use(cors()); // CORS — tighten origin in production
app.use(express.json({ limit: '10kb' })); // body parser with size limit
app.use(express.urlencoded({ extended: true }));

// ── Health check ────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// ── API routes ──────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/users', userRoutes);

// ── 404 catch-all ───────────────────────────────────────────────
app.all('*', (req, _res, next) => {
  const AppError = require('./utils/AppError');
  next(new AppError(`Route ${req.originalUrl} not found`, 404));
});

// ── Global error handler (MUST be last) ─────────────────────────
app.use(errorHandler);

module.exports = app;
