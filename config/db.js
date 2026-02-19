const mongoose = require('mongoose');

/**
 * Connect to MongoDB with retry logic.
 * Mongoose buffers commands until connected, so callers can
 * start using models immediately after calling this function.
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error(`❌ MongoDB connection error: ${err.message}`);
    // Exit process on failure so container orchestrators can restart
    process.exit(1);
  }
};

module.exports = connectDB;
