const mongoose = require("mongoose");

// Define an EventDetection schema to store detected information from media
const eventDetectionSchema = new mongoose.Schema({
  eventName: { type: String, required: true },
  eventDate: { type: Date, required: true },
  eventTime: { type: String },
  eventLocation: { type: String },
  eventDescription: { type: String },
  sourceType: {
    type: String,
    enum: ["image", "document", "text"],
    default: "text",
  },
  confidence: { type: Number, default: 0.7 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("EventDetection", eventDetectionSchema); 