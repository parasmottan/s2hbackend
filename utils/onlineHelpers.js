/**
 * In-memory registry of currently online helpers.
 *
 * Maps helperId (string) → socketId (string).
 *
 * This is intentionally kept in-process memory for simplicity.
 * For horizontal scaling, replace this Map with Redis pub/sub.
 */
const onlineHelpers = new Map();

const setOnline = (helperId, socketId) => {
  onlineHelpers.set(helperId, socketId);
};

const setOffline = (helperId) => {
  onlineHelpers.delete(helperId);
};

const isOnline = (helperId) => {
  return onlineHelpers.has(helperId);
};

const getSocketId = (helperId) => {
  return onlineHelpers.get(helperId);
};

/**
 * @returns {Map<string, string>} All currently online helpers
 */
const getAll = () => {
  return onlineHelpers;
};

module.exports = { setOnline, setOffline, isOnline, getSocketId, getAll };
