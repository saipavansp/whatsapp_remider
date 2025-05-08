const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const readFileAsync = promisify(fs.readFile);
const config = require("./config");

/**
 * Send a text message to a WhatsApp user
 * @param {string} to - The recipient's phone number
 * @param {string} body - The message content
 * @param {string} messageId - Optional ID of message to reply to
 * @returns {Promise<Object>} - WhatsApp API response data
 */
async function sendMessage(to, body, messageId = null) {
  try {
    const data = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body,
      },
    };

    // If messageId is provided, add context for reply
    if (messageId) {
      data.context = {
        message_id: messageId,
      };
    }

    const response = await axios({
      url: `https://graph.facebook.com/v21.0/${config.PHONE_NUMBER_ID}/messages`,
      method: "post",
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      data: JSON.stringify(data),
    });

    console.log(`Message sent successfully to ${to}`);
    return response.data;
  } catch (error) {
    console.error(
      "Error sending message:",
      error.response ? error.response.data : error.message,
    );
    throw error;
  }
}

/**
 * Get media URL from WhatsApp API
 * @param {string} mediaId - The media ID
 * @returns {Promise<string>} - URL to the media file
 */
async function getMediaUrl(mediaId) {
  try {
    // Get media URL from WhatsApp API
    const response = await axios({
      url: `https://graph.facebook.com/v21.0/${mediaId}`,
      method: "get",
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
      },
    });

    // Get the actual media content
    const mediaData = await axios({
      url: response.data.url,
      method: "get",
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
      },
      responseType: "arraybuffer",
    });

    // Save the media locally
    const fileExtension = response.data.mime_type.split("/")[1];
    const fileName = `${Date.now()}.${fileExtension}`;
    const filePath = path.join(__dirname, "..", "uploads", fileName);

    // Ensure uploads directory exists
    if (!fs.existsSync(path.join(__dirname, "..", "uploads"))) {
      fs.mkdirSync(path.join(__dirname, "..", "uploads"), { recursive: true });
    }

    fs.writeFileSync(filePath, mediaData.data);

    return `/uploads/${fileName}`; // Return the local path
  } catch (error) {
    console.error("Error getting media:", error);
    return null;
  }
}

/**
 * Send a message with retry logic
 * @param {string} to - Recipient's phone number
 * @param {string} body - Message content
 * @param {string} messageId - Optional message ID to reply to
 * @param {number} maxRetries - Maximum number of retry attempts
 * @returns {Promise<Object|null>} - WhatsApp API response or null if failed
 */
async function sendMessageWithRetry(to, body, messageId = null, maxRetries = 3) {
  let attempts = 0;
  let lastError = null;

  while (attempts < maxRetries) {
    try {
      const result = await sendMessage(to, body, messageId);
      return result;
    } catch (error) {
      lastError = error;
      attempts++;
      console.log(`Retry attempt ${attempts}/${maxRetries} for message to ${to}`);
      
      // Wait before retrying (exponential backoff)
      const delay = Math.pow(2, attempts) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  console.error(`Failed to send message after ${maxRetries} attempts: ${lastError?.message}`);
  return null;
}

module.exports = {
  sendMessage,
  getMediaUrl,
  sendMessageWithRetry
}; 