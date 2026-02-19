const User = require('../models/User');
const { DEFAULTS } = require('../config/constants');

/**
 * Find helpers that are:
 *   1. Within `radiusKm` of the given coordinates (geospatial query)
 *   2. Currently online (isOnline: true)
 *   3. Have the role 'helper'
 *
 * Uses MongoDB $nearSphere with $maxDistance (in metres).
 *
 * @param {number} lng        Longitude
 * @param {number} lat        Latitude
 * @param {number} [radiusKm] Search radius in kilometres
 * @returns {Promise<Array>}  Array of matching User documents
 */
const findNearbyHelpers = async (lng, lat, radiusKm) => {
  const radius = radiusKm || DEFAULTS.SEARCH_RADIUS_KM;

  console.log(`[Geo] Searching nearby: lng=${lng}, lat=${lat}, r=${radius}km`)

  try {
    const helpers = await User.find({
      role: 'helper',
      isOnline: true,
      currentLocation: {
        $nearSphere: {
          $geometry: {
            type: 'Point',
            coordinates: [lng, lat],
          },
          $maxDistance: radius * 1000, // convert km -> metres
        },
      },
    }).select('-password');

    console.log(`[Geo] Found ${helpers.length} nearby helpers:`, helpers.map(h => `${h._id} (${h.name})`))
    return helpers;
  } catch (err) {
    console.error('[Geo] Error finding helpers:', err.message);
    throw err;
  }
};

module.exports = { findNearbyHelpers };
