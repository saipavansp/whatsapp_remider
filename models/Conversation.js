const mongoose = require("mongoose");

// Define Conversation Schema
const conversationSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  messages: [
    {
      role: { type: String, enum: ["user", "assistant"], required: true },
      content: { type: String, required: true },
      timestamp: { type: Date, default: Date.now },
      mediaType: {
        type: String,
        enum: ["text", "image", "document", "none"],
        default: "text",
      },
      mediaUrl: { type: String, default: null },
    },
  ],
  lastInteraction: { type: Date, default: Date.now },
  eventAlreadyCreated: { type: Boolean, default: false },
});

module.exports = mongoose.model("Conversation", conversationSchema);
