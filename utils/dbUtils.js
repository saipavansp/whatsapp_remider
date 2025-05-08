const mongoose = require("mongoose");
const config = require("./config");
const { Conversation } = require("../models");

/**
 * Initialize the MongoDB connection
 * @returns {Promise<void>}
 */
async function initializeDatabase() {
  try {
    await mongoose.connect(config.MONGODB_URI);
    console.log("Connected to MongoDB");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    throw err;
  }
}

/**
 * Get or create conversation for a user
 * @param {string} userId - The user's phone number
 * @returns {Promise<Document>} - Mongoose document with conversation
 */
async function getOrCreateConversation(userId) {
  try {
    let conversation = await Conversation.findOne({ userId });

    if (!conversation) {
      conversation = new Conversation({
        userId,
        messages: [],
        lastInteraction: new Date(),
      });
    }

    return conversation;
  } catch (error) {
    console.error("Error in getOrCreateConversation:", error);
    throw error;
  }
}

/**
 * Add a message to conversation history
 * @param {string} userId - User's phone number
 * @param {string} role - Message role ('user' or 'assistant')
 * @param {string} content - Message content
 * @param {string} mediaType - Type of media ('text', 'image', 'document', 'none')
 * @param {string} mediaUrl - URL to the media (if any)
 * @returns {Promise<Document>} - Updated conversation
 */
async function addMessageToConversation(userId, role, content, mediaType = "text", mediaUrl = null) {
  try {
    const conversation = await getOrCreateConversation(userId);
    
    conversation.messages.push({
      role,
      content,
      mediaType,
      mediaUrl,
      timestamp: new Date()
    });
    
    conversation.lastInteraction = new Date();
    return await conversation.save();
  } catch (error) {
    console.error("Error adding message to conversation:", error);
    throw error;
  }
}

/**
 * Clean up old conversations (older than specified days)
 * @param {number} daysToKeep - Number of days to keep conversations (default 30)
 * @returns {Promise<number>} - Number of deleted conversations
 */
async function cleanupOldConversations(daysToKeep = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  try {
    const result = await Conversation.deleteMany({
      lastInteraction: { $lt: cutoffDate },
    });
    console.log(`Cleaned up ${result.deletedCount} old conversations`);
    return result.deletedCount;
  } catch (error) {
    console.error("Error cleaning up old conversations:", error);
    throw error;
  }
}

module.exports = {
  initializeDatabase,
  getOrCreateConversation,
  addMessageToConversation,
  cleanupOldConversations
}; 