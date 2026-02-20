/**
 * In-memory registry of currently online helpers.
 *
 * Maps helperId (string) → { socketId, longitude, latitude }
 *
 * This is the SINGLE SOURCE OF TRUTH for real-time helper availability.
 * Never rely on DB isOnline field for emit targeting.
 *
 * For horizontal scaling, replace this Map with Redis pub/sub.
 */
const helpers = new Map();

/**
 * Reverse map: socketId → helperId
 * Used for fast cleanup on disconnect (we only have socket.id at that point).
 */
const socketToHelper = new Map();

// ─── Public API ─────────────────────────────────────────────────

/**
 * Mark a helper as online and store their socket + location.
 */
const setOnline = (helperId, socketId, longitude = 0, latitude = 0) => {
  // Clean up any stale mapping for this helper
  const existing = helpers.get(helperId);
  if (existing && existing.socketId !== socketId) {
    socketToHelper.delete(existing.socketId);
  }

  helpers.set(helperId, { socketId, longitude, latitude });
  socketToHelper.set(socketId, helperId);
};

/**
 * Mark a helper as offline and remove all mappings.
 */
const setOffline = (helperId) => {
  const entry = helpers.get(helperId);
  if (entry) {
    socketToHelper.delete(entry.socketId);
  }
  helpers.delete(helperId);
};

/**
 * Remove a helper by their socketId (used on disconnect when we
 * only have the socket.id and need to clean up).
 * Returns the helperId that was removed, or null.
 */
const removeBySocketId = (socketId) => {
  const helperId = socketToHelper.get(socketId);
  if (!helperId) return null;

  socketToHelper.delete(socketId);
  // Only remove from helpers map if the socketId still matches
  // (prevents removing a reconnected helper's new entry)
  const entry = helpers.get(helperId);
  if (entry && entry.socketId === socketId) {
    helpers.delete(helperId);
  }
  return helperId;
};

/**
 * Check if a helper is currently online.
 */
const isOnline = (helperId) => {
  return helpers.has(helperId);
};

/**
 * Get the socketId for a specific helper. Returns undefined if offline.
 */
const getSocketId = (helperId) => {
  const entry = helpers.get(helperId);
  return entry ? entry.socketId : undefined;
};

/**
 * Get the full entry { socketId, longitude, latitude } for a helper.
 */
const getEntry = (helperId) => {
  return helpers.get(helperId) || null;
};

/**
 * Update just the location for an already-online helper.
 */
const updateLocation = (helperId, longitude, latitude) => {
  const entry = helpers.get(helperId);
  if (entry) {
    entry.longitude = longitude;
    entry.latitude = latitude;
  }
};

/**
 * Get all online helper IDs as an array.
 */
const getAllOnlineIds = () => {
  return Array.from(helpers.keys());
};

/**
 * Get the full internal map (for debugging / iteration).
 * @returns {Map<string, {socketId: string, longitude: number, latitude: number}>}
 */
const getAll = () => {
  return helpers;
};

/**
 * Get the count of currently online helpers.
 */
const count = () => {
  return helpers.size;
};

module.exports = {
  setOnline,
  setOffline,
  removeBySocketId,
  isOnline,
  getSocketId,
  getEntry,
  updateLocation,
  getAllOnlineIds,
  getAll,
  count,
};
