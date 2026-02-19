/**
 * Central constants used across the application.
 * Keeping magic strings / numbers here prevents typos and
 * makes refactoring trivial.
 */

// ── Request status machine ──────────────────────────────────────
const REQUEST_STATUS = Object.freeze({
  SEARCHING: 'searching',
  HELPER_ACCEPTED: 'helper_accepted',
  CONFIRMED: 'confirmed',
  ON_THE_WAY: 'on_the_way',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

// ── User roles ──────────────────────────────────────────────────
const ROLES = Object.freeze({
  SEEKER: 'seeker',
  HELPER: 'helper',
});

// ── Socket event names ──────────────────────────────────────────
const SOCKET_EVENTS = Object.freeze({
  // Seeker emits
  SEARCH_HELP: 'search_help',
  CONFIRM_HELPER: 'confirm_helper',
  CANCEL_REQUEST: 'cancel_request',

  // Helper emits
  GO_ONLINE: 'go_online',
  GO_OFFLINE: 'go_offline',
  ACCEPT_REQUEST: 'accept_request',
  REJECT_REQUEST: 'reject_request',
  LOCATION_UPDATE: 'location_update',

  // Server emits
  NEW_REQUEST: 'new_request',
  HELPER_FOUND: 'helper_found',
  REQUEST_LOCKED: 'request_locked',
  REQUEST_EXPIRED: 'request_expired',
  HELPER_ON_THE_WAY: 'helper_on_the_way',
  ARRIVAL_TIMER_STARTED: 'arrival_timer_started',

  // Generic
  ERROR: 'error',
  CONNECTION: 'connection',
  DISCONNECT: 'disconnect',
});

// ── Defaults ────────────────────────────────────────────────────
const DEFAULTS = Object.freeze({
  SEARCH_RADIUS_KM: Number(process.env.SEARCH_RADIUS_KM) || 10,
  REQUEST_TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS) || 300000, // 5 min
});

module.exports = { REQUEST_STATUS, ROLES, SOCKET_EVENTS, DEFAULTS };
