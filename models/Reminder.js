const mongoose = require("mongoose");

// Define Reminder Schema with enhanced fields
const reminderSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  message: { type: String, required: true },
  scheduledTime: { type: Date, required: true, index: true },
  timezone: { type: String, default: "Asia/Kolkata" },
  isCompleted: { type: Boolean, default: false },
  isPaused: { type: Boolean, default: false },
  isRecurring: { type: Boolean, default: false },
  recurringPattern: { type: String, default: null },
  category: {
    type: String,
    enum: ["work", "personal", "health", "finance", "other"],
    default: "other",
  },
  status: {
    type: String,
    enum: ["active", "paused", "completed"],
    default: "active",
  },
  type: {
    type: String,
    enum: ["standard", "daily_briefing"],
    default: "standard",
  },
  createdAt: { type: Date, default: Date.now },
  lastUpdated: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Reminder", reminderSchema); 