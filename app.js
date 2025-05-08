const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const schedule = require("node-schedule");
const moment = require("moment-timezone");

// Import utilities and engines
const { config, dbUtils, aiUtils, messageUtils, validationUtils } = require("./utils");
const reminderEngine = require("./engines/reminderEngine");
const notificationEngine = require("./engines/notificationEngine");
const queryEngine = require("./engines/queryEngine");
const { Reminder } = require("./models");

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "./uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// Create Express application
const app = express();
app.use(express.json());
app.use("/uploads", express.static("uploads"));

// Root endpoint 
app.get("/", (req, res) => {
  res.send("Advanced WhatsApp Chatbot with Three-Engine Architecture");
});

// Webhook verification endpoint (GET method)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const challenge = req.query["hub.challenge"];
  const token = req.query["hub.verify_token"];

  if (mode && token === config.WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook processing endpoint (POST method)
app.post("/webhook", async (req, res) => {
  try {
    const { entry } = req.body;

    // Validate request
    if (!entry || entry.length === 0) {
      return res.status(400).send("Invalid Request");
    }

    const changes = entry[0].changes;
    if (!changes || changes.length === 0) {
      return res.status(400).send("Invalid Request");
    }

    // Handle message status updates
    const statuses = changes[0].value.statuses
      ? changes[0].value.statuses[0]
      : null;
    if (statuses) {
      console.log(`
        MESSAGE STATUS UPDATE:
        ID: ${statuses.id},
        STATUS: ${statuses.status}
      `);
    }

    // Process incoming messages
    const messages = changes[0].value.messages
      ? changes[0].value.messages[0]
      : null;

    if (messages) {
      await processIncomingMessage(messages);
    }

    res.status(200).send("Webhook processed");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal Server Error");
  }
});

/**
 * Process an incoming WhatsApp message
 * @param {Object} message - The incoming message object
 */
async function processIncomingMessage(message) {
  try {
    const userId = message.from;
    let userMessageContent = "";
    let mediaType = "text";
    let mediaUrl = null;

    // Extract message content based on message type
    if (message.type === "text") {
      userMessageContent = message.text.body;
      console.log(`Received text message: "${userMessageContent}" from ${userId}`);
    } else if (message.type === "image") {
      mediaType = "image";
      mediaUrl = await messageUtils.getMediaUrl(message.image.id);
      userMessageContent = "[Image sent by user]";
    } else if (message.type === "document") {
      mediaType = "document";
      mediaUrl = await messageUtils.getMediaUrl(message.document.id);
      userMessageContent = `[Document sent by user: ${message.document.filename}]`;
    } else {
      mediaType = "none";
      userMessageContent = `[Unsupported message type: ${message.type}]`;
    }

    // Add message to conversation history
    await dbUtils.addMessageToConversation(userId, "user", userMessageContent, mediaType, mediaUrl);

    // Detect user intent using AI (can be skipped if media is present and processed)
    let userIntent = null;
    if (mediaType === "text") { // Only detect intent for text messages initially
        userIntent = await aiUtils.detectUserIntent(userMessageContent);
        console.log(`Detected intent: ${userIntent.intent} with confidence ${userIntent.confidence}`);
    }

    // Pre-process for event detection from text or media
    const preprocessingResult = await preprocessEventDetection(userId, userMessageContent, userIntent, mediaType, mediaUrl);

    // Case 1: Media event processing was attempted but failed (e.g., duplicate on retry or error during actual creation)
    if (preprocessingResult && preprocessingResult.eventProcessingAttemptedForMediaFailed === true) {
      console.log(`Media event processing for "${userMessageContent}" was attempted but failed internally. Assuming original confirmation sent or no further action needed.`);
      return; // Stop processing this message further to prevent conflicting errors.
    }

    // Case 2: Event was successfully created/handled by preprocessEventDetection (is an eventReminder object)
    // Ensure it's not the failure object from Case 1 before treating as a success.
    if (preprocessingResult && typeof preprocessingResult === 'object' && !preprocessingResult.eventProcessingAttemptedForMediaFailed) {
      const eventReminder = preprocessingResult; // It's a valid eventReminder object
      console.log("Event was created/identified automatically during preprocessing. Skipping further intent processing.");
      return; 
    }

    // Case 3: preprocessingResult is null (no event detected or it was a text event that didn't qualify)
    // Proceed with standard intent detection and processing...
    console.log("No event preprocessed, or preprocessingResult was null. Proceeding to intent detection.");

    // If no event was preprocessed (e.g. it was a text message without event info, or media processing failed/no event found)
    // and userIntent wasn't set (because it was media), detect intent now.
    if (!userIntent && mediaType !== "text") {
        userIntent = await aiUtils.detectUserIntent(userMessageContent); // Use a generic content for media if needed
        console.log(`Detected intent for media: ${userIntent?.intent} with confidence ${userIntent?.confidence}`); // Optional chaining
    }

    // If userIntent is still null (e.g. unsupported message type that wasn't an event)
    // or intent detection failed, handle gracefully or send a default message.
    if (!userIntent) {
        console.log("Could not determine user intent. Sending a generic response.");
        await messageUtils.sendMessageWithRetry(userId, "I'm not sure how to help with that. Can you try rephrasing?", message.id);
        return;
    }

    // Process the message based on detected intent
    const response = await processMessageBasedOnIntent(userId, userMessageContent, userIntent, mediaType, mediaUrl, message.id);

    // Get conversation history for validation
    const conversation = await dbUtils.getOrCreateConversation(userId);

    // Get relevant reminders for validation
    let relevantReminders = [];
    try {
      // For specific date queries, get those reminders
      if (userIntent.intent === "query_specific_date" || 
          userIntent.intent === "query_today" || 
          userIntent.intent === "query_tomorrow") {
        const dateInfo = await aiUtils.extractDateFromMessage(userMessageContent);
        if (dateInfo.extractedDate) {
          relevantReminders = await queryEngine.getRemindersForDay(userId, dateInfo.extractedDate);
        } else {
          // Fall back to all reminders
          relevantReminders = await queryEngine.getAllReminders(userId);
        }
      } else {
        // For other queries, get all active reminders
        relevantReminders = await queryEngine.getAllReminders(userId);
      }
    } catch (error) {
      console.error("Error getting reminders for validation:", error);
    }

    // Validate the response before sending
    console.log("Validating response against user query and retrieved data...");
    const validationResult = await validationUtils.validateResponse(
      userMessageContent, 
      relevantReminders,
      conversation.messages, 
      response
    );

    // Use validated/corrected response if needed
    const finalResponse = validationResult.isCorrect ? 
      response : 
      validationResult.correctedResponse || response;

    if (!validationResult.isCorrect && validationResult.correctedResponse) {
      console.log(`Response corrected by validation layer: ${validationResult.explanation}`);
    }

    // Add AI response to conversation history
    await dbUtils.addMessageToConversation(userId, "assistant", finalResponse, "text");

    // Send response to user
    await messageUtils.sendMessageWithRetry(userId, finalResponse, message.id);
  } catch (error) {
    console.error("Error processing message:", error);
    // Avoid sending an error message if an event was already handled.
    // The check for eventReminder could be done here as well, or rely on the return earlier.
    // For now, we'll assume the early return handles this.
    // If not, and an error occurs after event creation, we might still send an error message.
    // A more robust solution would be to track if a primary action (like event creation) has succeeded.
  }
}

/**
 * Pre-process a message for event detection before intent handling
 * @param {string} userId - User ID
 * @param {string} messageContent - Message content
 * @param {Object} userIntent - Detected intent
 * @param {string} mediaType - Type of media
 * @param {string} mediaUrl - URL to media if any
 * @returns {Promise<Object|null>} - Return event reminder if created, otherwise null
 */
async function preprocessEventDetection(userId, messageContent, userIntent, mediaType, mediaUrl) {
  try { // Outer try-catch for general errors in this function

    // Skip event detection for query intents or cancel intents
    const isQueryIntent = [
      "query_today", 
      "query_tomorrow", 
      "query_week", 
      "query_month", 
      "list_reminders", 
      "upcoming_events",
      "last_reminder"
    ].includes(userIntent?.intent); // Added optional chaining for userIntent

    if (isQueryIntent || userIntent?.intent === "cancel_reminder") { // Added optional chaining
      return null;
    }

    // For text messages, check if they contain event information
    if (mediaType === "text") {
      const containsEventInfo = await aiUtils.checkIfTextContainsEvent(messageContent);
      if (containsEventInfo.isEvent && containsEventInfo.confidence >= 0.8) {
        const looksLikeQuery = /what|show|list|tell me about|do i have|when is/i.test(messageContent.toLowerCase());

        if (!looksLikeQuery) {
          const eventDetails = await aiUtils.extractEventFromText(messageContent);
          if (eventDetails) {
            const eventReminder = await reminderEngine.createEventReminder(userId, eventDetails);
            console.log(`Automatically added event from text: ${eventDetails.eventName}`);
            const eventDate = moment(eventDetails.eventDate).tz(config.DEFAULT_TIMEZONE);
            const dayOfWeek = eventDate.format("dddd");
            await messageUtils.sendMessageWithRetry(
              userId,
              `✅ I've added "${eventDetails.eventName}" to your calendar for ${dayOfWeek}, ${eventDate.format("MMMM D, YYYY")} at ${eventDetails.eventTime || "all day"} ${eventDetails.eventLocation ? `at ${eventDetails.eventLocation}` : ""}.`
            );
            try {
              await notificationEngine.addReminder(eventReminder);
            } catch (notificationError) {
                console.error(`Failed to schedule notification for text event "${eventDetails.eventName}" after user confirmation:`, notificationError);
            }
            return eventReminder;
          }
        } else {
          console.log("Skipping text event extraction because message looks like a query");
        }
      }
    }
    // Process image events
    else if (mediaType === "image" || mediaType === "document") {
      const eventDetails = await aiUtils.extractEventFromMedia(mediaUrl, mediaType);

      if (eventDetails && eventDetails.confidence >= 0.75) {
        console.log(`Detected event from ${mediaType}: ${eventDetails.eventName}`);

        // Placeholder for a proper duplicate check that would return an existingEvent object
        // if (await reminderEngine.findSimilarEvent(userId, eventDetails)) {
        //   console.log("Similar event already exists. Returning existing.");
        //   return await reminderEngine.findSimilarEvent(userId, eventDetails); // Ideal
        // }

        try {
          // Attempt to create the event
          const eventReminder = await reminderEngine.createEventReminder(userId, eventDetails);

          // If creation successful, format details and send confirmation
          const eventDate = moment(eventDetails.eventDate).tz(config.DEFAULT_TIMEZONE);
          const dayOfWeek = eventDate.format("dddd");
          const detailsMessageList = [
            `* *Event:* ${eventDetails.eventName}`,
            `* *Date:* ${eventDate.format("MMMM D")}`,
            `* *Location:* ${eventDetails.eventLocation || "Not specified"}`,
          ];
          if (eventDetails.eventHost) detailsMessageList.push(`* *Host:* ${eventDetails.eventHost}`);
          if (eventDetails.eventTime) detailsMessageList.push(`* *Time:* ${eventDetails.eventTime}`);
          else detailsMessageList.push(`* *Time:* All day`);
          if (eventDetails.eventContact) detailsMessageList.push(`* *Contact:* ${eventDetails.eventContact}`);
          if (eventDetails.eventWebsite) detailsMessageList.push(`* *Website:* ${eventDetails.eventWebsite}`);

          // Corrected template literal for the confirmation message
          const confirmationMessage = `✅ I've added "${eventDetails.eventName}" to your calendar for ${dayOfWeek}, ${eventDate.format("MMMM D, YYYY")} at ${eventDetails.eventTime || "all day"} ${eventDetails.eventLocation ? `at ${eventDetails.eventLocation}` : ""}.\n\nHere are the details I extracted:\n\n${detailsMessageList.join("\n")}`;

          await messageUtils.sendMessageWithRetry(userId, confirmationMessage);

          // Attempt to schedule notification
          try {
            await notificationEngine.addReminder(eventReminder);
          } catch (notificationError) {
            console.error(`Failed to schedule notification for media event "${eventDetails.eventName}" after user confirmation:`, notificationError);
          }

          return eventReminder; // SUCCESS for this media event

        } catch (creationOrConfirmationError) {
          // This error occurred trying to create the event or send its confirmation.
          console.error(`Error during event creation/confirmation for ${mediaType} (event: "${eventDetails.eventName}"):`, creationOrConfirmationError);
          // Signal that processing was attempted for this media as an event, but it failed.
          return { eventProcessingAttemptedForMediaFailed: true };
        }
      }
      // If eventDetails not extracted or low confidence, it's not treated as an event by this block.
    }

    return null; // Default: no event processed by this function

  } catch (error) { // Catch-all for preprocessEventDetection
    console.error("Error in event preprocessing (outer catch):", error);
    return null; // General failure in preprocessing
  }
}

/**
 * Process a message based on the detected intent
 * @param {string} userId - User ID
 * @param {string} messageContent - Message content
 * @param {Object} userIntent - Detected intent
 * @param {string} mediaType - Type of media
 * @param {string} mediaUrl - URL to media if any
 * @param {string} messageId - Original message ID
 * @returns {Promise<string>} - Response to send to user
 */
async function processMessageBasedOnIntent(userId, messageContent, userIntent, mediaType, mediaUrl, messageId) {
  try {
    // SPECIAL CASE: First check for date patterns in the message
    // This overrides intent detection as a safety measure
    if (messageContent.toLowerCase().match(/on\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)[\s,]+\d{1,2}(st|nd|rd|th)?/i) || 
        messageContent.toLowerCase().match(/for\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)[\s,]+\d{1,2}(st|nd|rd|th)?/i)) {

      console.log("Date pattern detected in message, overriding intent to query_specific_date");

      // Extract the date from the message
      const dateInfo = await aiUtils.extractDateFromMessage(messageContent);

      // If date extraction successful, process as a specific date query
      if (dateInfo.extractedDate) {
        console.log(`Extracted specific date: ${dateInfo.extractedDate} with confidence ${dateInfo.confidence}`);

        // Get reminders for the extracted date
        const result = await queryEngine.getRemindersForSpecificDate(
          userId, 
          dateInfo.extractedDate,
          config.DEFAULT_TIMEZONE
        );

        return result.message;
      }
    }

    // REGULAR INTENT PROCESSING
    // QUERY INTENTS - handled by query engine
    if (userIntent.intent === "query_today" || 
        (userIntent.intent === "list_reminders" && messageContent.toLowerCase().includes("today"))) {
      const result = await queryEngine.getTodayReminders(userId, config.DEFAULT_TIMEZONE);
      return result.message;
    } 
    else if (userIntent.intent === "query_tomorrow" || 
             (userIntent.intent === "list_reminders" && messageContent.toLowerCase().includes("tomorrow"))) {
      const result = await queryEngine.getTomorrowReminders(userId, config.DEFAULT_TIMEZONE);
      return result.message;
    } 
    else if (userIntent.intent === "query_specific_date" && userIntent.confidence >= 0.7) {
      // Extract the specific date from the message
      const dateInfo = await aiUtils.extractDateFromMessage(messageContent);

      // If no date found or low confidence, fallback to general reminders list
      if (!dateInfo.extractedDate || dateInfo.confidence < 0.7) {
        console.log("Couldn't extract specific date with high confidence, showing all reminders");
        const reminders = await queryEngine.getAllReminders(userId);
        return queryEngine.formatRemindersList(reminders);
      }

      // Get reminders for the extracted date
      const result = await queryEngine.getRemindersForSpecificDate(
        userId, 
        dateInfo.extractedDate,
        config.DEFAULT_TIMEZONE
      );

      return result.message;
    }
    else if (userIntent.intent === "query_week") {
      const result = await queryEngine.getWeekReminders(userId, config.DEFAULT_TIMEZONE);
      return result.message;
    } 
    else if (userIntent.intent === "query_month") {
      const result = await queryEngine.getMonthReminders(userId, config.DEFAULT_TIMEZONE);
      return result.message;
    } 
    else if (userIntent.intent === "list_reminders") {
      const reminders = await queryEngine.getAllReminders(userId);
      return queryEngine.formatRemindersList(reminders);
    } 
    else if (userIntent.intent === "upcoming_events") {
      const result = await queryEngine.getUpcomingReminders(userId);
      return result.message;
    } 
    else if (userIntent.intent === "last_reminder") {
      const result = await queryEngine.getLastReminder(userId);
      return result.message;
    } 
    else if (userIntent.intent === "query_category" && userIntent.category) {
      const result = await queryEngine.getRemindersByCategory(userId, userIntent.category);
      return result.message;
    }
    else if (userIntent.intent === "query_recurring" && userIntent.confidence >= 0.7) {
      // Handle query for recurring reminders
      const result = await queryEngine.getRecurringReminders(userId);
      return result.message;
    }
    // ACTION INTENTS - create/update/delete operations
    else if (userIntent.intent === "delete_date_reminders" && userIntent.confidence >= 0.7) {
      // Extract the date from the message
      const dateInfo = await aiUtils.extractDateFromMessage(messageContent);

      // If no date found, ask for clarification
      if (!dateInfo.extractedDate || dateInfo.confidence < 0.7) {
        return "I couldn't determine which date you want to delete reminders for. Please specify a clear date, like 'Delete all reminders for tomorrow' or 'Delete events on Friday'.";
      }

      // Get the reminders for that date first (to show the user what will be deleted)
      const remindersForDate = await queryEngine.getRemindersForDay(
        userId, 
        dateInfo.extractedDate,
        config.DEFAULT_TIMEZONE
      );

      // If no reminders found for that date
      if (remindersForDate.length === 0) {
        const dateString = moment(dateInfo.extractedDate)
          .tz(config.DEFAULT_TIMEZONE)
          .format("dddd, MMMM D");
        return `You don't have any reminders scheduled for ${dateString}.`;
      }

      // Delete the reminders for that date
      const deletedCount = await reminderEngine.deleteRemindersByDate(
        userId,
        dateInfo.extractedDate,
        config.DEFAULT_TIMEZONE
      );

      // Cancel any scheduled notifications for these reminders
      for (const reminder of remindersForDate) {
        notificationEngine.cancelReminder(reminder._id);
      }

      // Format response
      const dateString = moment(dateInfo.extractedDate)
        .tz(config.DEFAULT_TIMEZONE)
        .format("dddd, MMMM D");

      if (deletedCount > 0) {
        return `✅ Deleted ${deletedCount} reminder${deletedCount !== 1 ? 's' : ''} for ${dateString}.`;
      } else {
        return `No reminders were deleted for ${dateString}.`;
      }
    }
    else if (userIntent.intent === "delete_all_reminders" && userIntent.confidence >= 0.8) {
      // For safety, check if the message contains a clear confirmation phrase
      const confirmPhrases = [
        "delete all", "remove all", "clear all", "delete everything", 
        "remove everything", "erase all", "delete every reminder"
      ];

      const hasConfirmPhrase = confirmPhrases.some(phrase => 
        messageContent.toLowerCase().includes(phrase)
      );

      // If no clear confirmation in the initial message, ask for confirmation
      if (!hasConfirmPhrase) {
        // This is a confirmation request, not the actual deletion
        return "⚠️ Are you sure you want to delete ALL of your reminders? This cannot be undone. Reply with 'Yes, delete all my reminders' to confirm.";
      }

      // Check if this is a confirmation response
      const isConfirmation = messageContent.toLowerCase().includes("yes, delete") || 
                             (messageContent.toLowerCase().includes("yes") && 
                              messageContent.toLowerCase().includes("delete all"));

      if (!isConfirmation && !hasConfirmPhrase) {
        return "I didn't receive a clear confirmation. No reminders were deleted.";
      }

      // Get ALL reminders, including completed ones - we need to cancel all notifications
      const allReminders = await Reminder.find({ userId });

      if (allReminders.length === 0) {
        return "You don't have any reminders to delete.";
      }

      // Cancel ALL scheduled notifications at once
      notificationEngine.cancelAllRemindersForUser(userId);

      // Delete all reminders
      const deletedCount = await reminderEngine.deleteAllReminders(userId);

      return `✅ Deleted all ${deletedCount} of your reminders. Your schedule is now empty.`;
    }
    else if (userIntent.intent === "set_reminder" && userIntent.confidence >= 0.8) {
      // Double-check that this is actually a creation request, not a query
      const createTerms = ["add", "create", "set", "remind me", "schedule", "make"];
      const isExplicitCreate = createTerms.some(term => 
        messageContent.toLowerCase().includes(term)
      );

      if (!isExplicitCreate && userIntent.confidence < 0.95) {
        // Treat as a query instead (better to show info than create unwanted events)
        console.log("Overriding to query intent due to lack of explicit creation terms");
        const reminders = await queryEngine.getAllReminders(userId);
        return queryEngine.formatRemindersList(reminders);
      } 
      else {
        // Handle reminder creation intent
        const reminderDetails = await aiUtils.extractReminderDetails(messageContent);

        if (!reminderDetails) {
          return "I couldn't understand when and what to remind you about. Could you try again with a specific time and message?";
        }

        // Create the reminder with AI-detected category
        const reminder = await reminderEngine.createReminder(
          userId,
          reminderDetails.message,
          reminderDetails.time,
          reminderDetails.timezone || config.DEFAULT_TIMEZONE,
          reminderDetails.isRecurring,
          reminderDetails.recurringPattern,
          reminderDetails.category
        );

        // Schedule notification
        await notificationEngine.addReminder(reminder);

        // Format the time in the user's timezone
        const formattedTime = moment(reminderDetails.time)
          .tz(reminderDetails.timezone || config.DEFAULT_TIMEZONE)
          .format("ddd, MMM D, YYYY [at] h:mm A z");

        if (reminderDetails.isRecurring) {
          return `✅ Recurring reminder set: I'll remind you about "${reminderDetails.message}" ${reminderDetails.recurringPattern}, starting ${formattedTime} (Category: ${reminderDetails.category})`;
        } else {
          return `✅ Reminder set: I'll remind you about "${reminderDetails.message}" on ${formattedTime} (Category: ${reminderDetails.category})`;
        }
      }
    } 
    else if (userIntent.intent === "cancel_reminder" && userIntent.confidence >= 0.7) {
      // Identify which reminder to cancel
      const reminderToCancel = await queryEngine.identifyReminderFromMessage(userId, messageContent);

      if (reminderToCancel) {
        // Delete from database
        const deleted = await reminderEngine.deleteReminder(reminderToCancel._id);

        // Cancel scheduled notification
        notificationEngine.cancelReminder(reminderToCancel._id);

        return `✅ Canceled reminder: "${reminderToCancel.message}"`;
      } else {
        return "I couldn't identify which reminder you want to cancel. Please try 'Show my reminders' first and then specify which one to cancel.";
      }
    } 
    else if (userIntent.intent === "update_reminder" && userIntent.confidence >= 0.7) {
      // TODO: Implement reminder update logic
      return "I'm currently working on the ability to update reminders. Please try again later.";
    }
    else if (userIntent.intent === "pause_reminder" && userIntent.confidence >= 0.7) {
      // Identify which reminder to pause
      const reminderToPause = await queryEngine.identifyReminderFromMessage(userId, messageContent);

      if (reminderToPause) {
        // Pause the reminder
        const pausedReminder = await reminderEngine.pauseReminder(reminderToPause._id);
        // Cancel any scheduled notification
        notificationEngine.cancelReminder(reminderToPause._id);

        return `✅ Paused reminder: "${pausedReminder.message}" - you can resume it anytime by asking me`;
      } else {
        return "I couldn't identify which reminder you want to pause. Please try 'Show my reminders' first and then specify which one to pause.";
      }
    }
    else if (userIntent.intent === "resume_reminder" && userIntent.confidence >= 0.7) {
      // Identify which reminder to resume
      const reminderToResume = await queryEngine.identifyReminderFromMessage(userId, messageContent);

      if (reminderToResume) {
        // Resume the reminder
        const resumedReminder = await reminderEngine.resumeReminder(reminderToResume._id);
        // Reschedule the notification
        await notificationEngine.rescheduleReminder(resumedReminder._id);

        return `✅ Resumed reminder: "${resumedReminder.message}"`;
      } else {
        return "I couldn't identify which reminder you want to resume. Please try 'Show my reminders' first and then specify which one to resume.";
      }
    }
    else if (userIntent.intent === "daily_briefing" && userIntent.confidence >= 0.7) {
      // Extract the time for the daily briefing
      const timePattern = /(\d{1,2})(:|.)(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/i;
      const timeMatch = messageContent.match(timePattern);

      // Set default time to 8:00 AM
      const scheduledTime = moment().tz(config.DEFAULT_TIMEZONE);
      scheduledTime.hours(8);
      scheduledTime.minutes(0);
      scheduledTime.seconds(0);

      // If time specified, adjust
      if (timeMatch) {
        const hour = parseInt(timeMatch[1]);
        const minute = timeMatch[3] ? parseInt(timeMatch[3]) : 0;
        const isPM = timeMatch[4].toLowerCase().startsWith("p");

        scheduledTime.hours(isPM && hour < 12 ? hour + 12 : hour);
        scheduledTime.minutes(minute);
      }

      // If the time is in the past, move to tomorrow
      if (scheduledTime.isBefore(moment())) {
        scheduledTime.add(1, "day");
      }

      // Create the daily briefing reminder
      const briefingReminder = await reminderEngine.createDailyBriefingReminder(
        userId,
        scheduledTime.toDate(),
        config.DEFAULT_TIMEZONE
      );

      // Schedule notification
      await notificationEngine.addReminder(briefingReminder);

      // Format response
      return `✅ Daily briefing scheduled for ${scheduledTime.format("h:mm A")} every day. I'll send you a summary of your daily schedule each morning.`;
    }
    else {
      // Handle as a general query or fallback to Gemini
      const conversation = await dbUtils.getOrCreateConversation(userId);
      return await aiUtils.processMessageWithAI(conversation, mediaType, mediaUrl);
    }
  } catch (error) {
    console.error("Error processing intent:", error);
    return "I'm sorry, I ran into an issue processing your request. Please try again later.";
  }
}

// Application startup sequence
async function startApp() {
  try {
    // Initialize database connection
    await dbUtils.initializeDatabase();

    // Initialize notification engine
    await notificationEngine.initialize();

    // Set up cleanup tasks - daily at midnight
    schedule.scheduleJob("0 0 * * *", async () => {
      await dbUtils.cleanupOldConversations();
      await reminderEngine.cleanupOldReminders();
    });

    // Start the server
    const PORT = config.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Advanced WhatsApp Chatbot running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Error starting application:", error);
    process.exit(1);
  }
}

// Start the application
startApp(); 