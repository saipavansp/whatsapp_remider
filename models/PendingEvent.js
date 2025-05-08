const mongoose = require("mongoose");

// Define schema for temporary detected events pending confirmation
const pendingEventSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  eventDetails: { type: Object, required: true },
  detectedAt: { type: Date, default: Date.now },
  confirmed: { type: Boolean, default: false },
  mediaSource: {
    type: String,
    enum: ["image", "document", "text"],
    default: "text",
  },
});

// Add TTL index to automatically expire pending events after 2 hours
pendingEventSchema.index({ detectedAt: 1 }, { expireAfterSeconds: 7200 });

module.exports = mongoose.model("PendingEvent", pendingEventSchema); 