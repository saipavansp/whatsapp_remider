require('dotenv').config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const readFileAsync = promisify(fs.readFile);
const schedule = require("node-schedule");
const moment = require("moment-timezone");

// Configuration constants
const WHATSAPP_ACCESS_TOKEN =
  "EAAJU17wadOUBO6OSZASiKp6e4UZCj6ZBcebyZBBdQajul1zyzhWFPkblqXAQhZCepcEZAWlJBbgSTkmlBSSZAXmldt9Yl4ZAn2ZA3kl7XJsli43Fzihc8kIR0brDKGfrVvIy4IjRPpuIuqV7vHcTs6iqaS2otZBBK28ZCK3MdahfczPfcQiJ4UGII3PRhhlaP0gQP2pCQZDZD";
const WEBHOOK_VERIFY_TOKEN = "my-verify-token";
const PHONE_NUMBER_ID = "696349263551599"; // Replace with your actual phone number ID
const GEMINI_API_KEY = "AIzaSyAciVTIEXqmjinAmQERiBecrHOAIRvdqjo"; // Replace with your Gemini API key
const MONGODB_URI =
  "mongodb+srv://saipavansp242:XdMlz6oMFM3ugsRz@whastapp.uskziwp.mongodb.net/";
const DEFAULT_TIMEZONE = "Asia/Kolkata"; // IST timezone


// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Connect to MongoDB
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

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

// Define Reminder Schema with enhanced fields
const reminderSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  message: { type: String, required: true },
  scheduledTime: { type: Date, required: true, index: true },
  timezone: { type: String, default: DEFAULT_TIMEZONE },
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

// Define an additional EventDetection schema to store detected information from media
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

// Create models
const Conversation = mongoose.model("Conversation", conversationSchema);
const Reminder = mongoose.model("Reminder", reminderSchema);
const EventDetection = mongoose.model("EventDetection", eventDetectionSchema);
const PendingEvent = mongoose.model("PendingEvent", pendingEventSchema);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "./uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// Set up Express app
const app = express();
app.use(express.json());
app.use("/uploads", express.static("uploads"));

app.get("/", (req, res) => {
  res.send("Advanced WhatsApp Chatbot ");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const challenge = req.query["hub.challenge"];
  const token = req.query["hub.verify_token"];

  if (mode && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const { entry } = req.body;

    if (!entry || entry.length === 0) {
      return res.status(400).send("Invalid Request");
    }

    const changes = entry[0].changes;

    if (!changes || changes.length === 0) {
      return res.status(400).send("Invalid Request");
    }

    const statuses = changes[0].value.statuses
      ? changes[0].value.statuses[0]
      : null;
    const messages = changes[0].value.messages
      ? changes[0].value.messages[0]
      : null;

    if (statuses) {
      // Handle message status
      console.log(`
        MESSAGE STATUS UPDATE:
        ID: ${statuses.id},
        STATUS: ${statuses.status}
      `);
    }

    if (messages) {
      const userId = messages.from;

      // Process different types of messages
      let userMessageContent = "";
      let mediaType = "text";
      let mediaUrl = null;

      if (messages.type === "text") {
        userMessageContent = messages.text.body;
        console.log(`Received text message: "${userMessageContent}" from ${userId}`);

        // Check if this is a regular text message that contains event information
        const containsEventInfo = await checkIfTextContainsEvent(userMessageContent);
        if (containsEventInfo.isEvent && containsEventInfo.confidence >= 0.8) {
          // Double-check that this doesn't look like a query
          const looksLikeQuery = /what|show|list|tell me about|do i have|when is/i.test(userMessageContent.toLowerCase());
          
          if (!looksLikeQuery) {
            // Extract event details
            const eventDetails = await extractEventFromText(userMessageContent);
            if (eventDetails) {
              console.log("Extracted event details from text:", eventDetails);
              // Store for later confirmation (text-based events require confirmation)
              await storeDetectedEvent(userId, eventDetails, "text");
            }
          } else {
            console.log("Skipping event extraction because message looks like a query");
          }
        }
      } else if (messages.type === "image") {
        mediaType = "image";
        // Get the media URL from WhatsApp
        mediaUrl = await getMediaUrl(messages.image.id);
        userMessageContent = "[Image sent by user]";

        // Get user conversation history first (needed for tracking event creation)
        const conversation = await getOrCreateConversation(userId);

        // Try to detect if this image contains event information
        const eventDetails = await extractEventFromMedia(mediaUrl, "image");
        if (eventDetails && eventDetails.confidence >= 0.75) {
          console.log(`Detected event from image: ${eventDetails.eventName}`);

          // Format event details for display
          const eventDate = moment(eventDetails.eventDate).tz(DEFAULT_TIMEZONE);
          const dayOfWeek = eventDate.format("dddd");

          // Create a formatted message with all available details
          const detailsMessage = [
            `* *Event:* ${eventDetails.eventName}`,
            `* *Date:* ${eventDate.format("MMMM D")}`,
            `* *Location:* ${eventDetails.eventLocation || "Not specified"}`,
          ];

          // Add optional fields if available
          if (eventDetails.eventHost) {
            detailsMessage.push(`* *Host:* ${eventDetails.eventHost}`);
          }

          if (eventDetails.eventTime) {
            detailsMessage.push(`* *Time:* ${eventDetails.eventTime}`);
          } else {
            detailsMessage.push(`* *Time:* All day`);
          }

          if (eventDetails.eventContact) {
            detailsMessage.push(`* *Contact:* ${eventDetails.eventContact}`);
          }

          if (eventDetails.eventWebsite) {
            detailsMessage.push(`* *Website:* ${eventDetails.eventWebsite}`);
          }

          // Directly create the event without asking for confirmation
          const eventReminder = await createEventReminder(userId, eventDetails);
          
          // Set a flag in the conversation to indicate this image already created an event
          // This will prevent the redundant "Would you like to add this..." question
          conversation.eventAlreadyCreated = true;
          await conversation.save(); // Save the updated conversation with the flag
          
          // Send notification to user
          await sendMessage(
            userId,
            `✅ I've added "${eventDetails.eventName}" to your calendar for ${dayOfWeek}, ${eventDate.format("MMMM D, YYYY")} at ${eventDetails.eventTime || "all day"} ${eventDetails.eventLocation ? `at ${eventDetails.eventLocation}` : ""}.\n\nHere are the details I extracted:\n\n` +
              detailsMessage.join("\n"),
          );
          // Stop further processing for this image message as event has been created
          res.status(200).send("Webhook processed");
          return;
        }
      } else if (messages.type === "document") {
        mediaType = "document";
        // Get the media URL from WhatsApp
        mediaUrl = await getMediaUrl(messages.document.id);
        userMessageContent = `[Document sent by user: ${messages.document.filename}]`;

        // Try to detect if this document contains event information
        const eventDetails = await extractEventFromMedia(mediaUrl, "document");
        if (eventDetails && eventDetails.confidence >= 0.75) {
          console.log(
            `Detected event from document: ${eventDetails.eventName}`,
          );

          // Format event details for display
          const eventDate = moment(eventDetails.eventDate).tz(DEFAULT_TIMEZONE);
          const dayOfWeek = eventDate.format("dddd");

          // Create a formatted message with all available details
          const detailsMessage = [
            `* *Event:* ${eventDetails.eventName}`,
            `* *Date:* ${eventDate.format("MMMM D")}`,
            `* *Location:* ${eventDetails.eventLocation || "Not specified"}`,
          ];

          // Add optional fields if available
          if (eventDetails.eventHost) {
            detailsMessage.push(`* *Host:* ${eventDetails.eventHost}`);
          }

          if (eventDetails.eventTime) {
            detailsMessage.push(`* *Time:* ${eventDetails.eventTime}`);
          } else {
            detailsMessage.push(`* *Time:* All day`);
          }

          if (eventDetails.eventContact) {
            detailsMessage.push(`* *Contact:* ${eventDetails.eventContact}`);
          }

          if (eventDetails.eventWebsite) {
            detailsMessage.push(`* *Website:* ${eventDetails.eventWebsite}`);
          }

          // Directly create the event without asking for confirmation
          const eventReminder = await createEventReminder(userId, eventDetails);

          // Send notification to user
          await sendMessage(
            userId,
            `✅ I've added "${eventDetails.eventName}" to your calendar for ${dayOfWeek}, ${eventDate.format("MMMM D, YYYY")} at ${eventDetails.eventTime || "all day"} ${eventDetails.eventLocation ? `at ${eventDetails.eventLocation}` : ""}.\n\nHere are the details I extracted:\n\n` +
              detailsMessage.join("\n"),
          );
          // Stop further processing for this document message as event has been created
          res.status(200).send("Webhook processed");
          return;
        }
      } else {
        mediaType = "none";
        userMessageContent = `[Unsupported message type: ${messages.type}]`;
      }

      // Get user conversation history
      const conversation = await getOrCreateConversation(userId);

      // Add user message to history
      conversation.messages.push({
        role: "user",
        content: userMessageContent,
        mediaType,
        mediaUrl,
      });
      conversation.lastInteraction = new Date();
      await conversation.save();

      // First, detect user intent
      const userIntent = await detectUserIntent(userMessageContent);
      console.log(
        `Detected intent: ${userIntent.intent} with confidence ${userIntent.confidence}`,
      );

      // Add a special pre-processing check for deletion commands with high confidence
      // This prevents misinterpreting deletion commands as creation commands
      if (
        userIntent.intent === "cancel_reminder" &&
        (userIntent.confidence > 0.9 ||
          userIntent.itemNumber ||
          userIntent.itemText)
      ) {
        console.log(
          "High confidence cancel intent detected, prioritizing deletion flow",
        );

        try {
          // First identify which reminder to cancel using the enhanced details
          const reminderToCancel = await identifyReminderToCancel(
            userId,
            userMessageContent,
            userIntent,
          );

          if (reminderToCancel) {
            // Perform deletion with proper cleanup
            await Reminder.findByIdAndDelete(reminderToCancel._id);

            // Also cancel any scheduled job
            const jobName = `reminder_${reminderToCancel._id}`;
            const existingJob = schedule.scheduledJobs[jobName];
            if (existingJob) {
              existingJob.cancel();
            }

            // Send confirmation to user
            const response = `✅ Canceled reminder: "${reminderToCancel.message}"`;
            await sendMessage(userId, response, messages.id);

            // Add response to conversation history
            conversation.messages.push({
              role: "assistant",
              content: response,
              mediaType: "text",
            });

            conversation.lastInteraction = new Date();
            await conversation.save();

            // Mark as processed and return
            console.log(
              `Successfully canceled reminder: ${reminderToCancel.message}`,
            );
            res.status(200).send("Webhook processed");
            return;
          }
        } catch (error) {
          console.error("Error in cancel reminder pre-processing:", error);
          // If pre-processing fails, continue with normal intent processing
        }
      }

      let aiResponse = "";

      // QUERY INTENTS - Process user's information requests without making changes
      if (
        userIntent.intent === "query_today" ||
        (userIntent.intent === "list_reminders" && 
         userMessageContent.toLowerCase().includes("today"))
      ) {
        // Handle request for today's reminders
        const today = moment().tz(DEFAULT_TIMEZONE).toDate();
        const reminders = await getRemindersForDay(
          userId,
          today,
          DEFAULT_TIMEZONE,
        );

        if (reminders.length === 0) {
          aiResponse = "You have no reminders scheduled for today.";
        } else {
          aiResponse =
            `📆 Your schedule for today (${moment().format("dddd, MMMM D")}):\n\n` +
            reminders
              .map((r, i) => {
                const time = moment(r.scheduledTime)
                  .tz(r.timezone)
                  .format("h:mm A");
                return `${i + 1}. ${time}: ${r.message} (${r.category})`;
              })
              .join("\n\n");
        }
      } else if (
        userIntent.intent === "query_tomorrow" ||
        (userIntent.intent === "list_reminders" && 
         userMessageContent.toLowerCase().includes("tomorrow"))
      ) {
        // Handle request for tomorrow's reminders
        const tomorrow = moment().tz(DEFAULT_TIMEZONE).add(1, "day").toDate();
        const reminders = await getRemindersForDay(
          userId,
          tomorrow,
          DEFAULT_TIMEZONE,
        );

        if (reminders.length === 0) {
          aiResponse = `You have no reminders scheduled for tomorrow (${moment().add(1, "day").format("dddd, MMMM D")}).`;
        } else {
          aiResponse =
            `📆 Your schedule for tomorrow (${moment().add(1, "day").format("dddd, MMMM D")}):\n\n` +
            reminders
              .map((r, i) => {
                const time = moment(r.scheduledTime)
                  .tz(r.timezone)
                  .format("h:mm A");
                return `${i + 1}. ${time}: ${r.message} (${r.category})`;
              })
              .join("\n\n");
        }
      } else if (userIntent.intent === "query_week") {
        // Handle request for this week's reminders
        const today = moment().tz(DEFAULT_TIMEZONE).toDate();
        const reminders = await getRemindersForWeek(
          userId,
          today,
          DEFAULT_TIMEZONE,
        );

        if (reminders.length === 0) {
          aiResponse = "You have no reminders scheduled for this week.";
        } else {
          // Group reminders by day
          const remindersByDay = {};
          reminders.forEach((reminder) => {
            const day = moment(reminder.scheduledTime)
              .tz(reminder.timezone)
              .format("dddd, MMMM D");
            if (!remindersByDay[day]) {
              remindersByDay[day] = [];
            }
            remindersByDay[day].push(reminder);
          });

          // Format the response
          aiResponse = `📅 Your schedule for this week:\n\n`;

          for (const day in remindersByDay) {
            aiResponse += `*${day}*\n`;
            remindersByDay[day].forEach((reminder, i) => {
              const time = moment(reminder.scheduledTime)
                .tz(reminder.timezone)
                .format("h:mm A");
              aiResponse += `${i + 1}. ${time}: ${reminder.message} (${reminder.category})\n`;
            });
            aiResponse += "\n";
          }
        }
      } else if (userIntent.intent === "query_month") {
        // Handle request for this month's reminders
        const today = moment().tz(DEFAULT_TIMEZONE).toDate();
        const reminders = await getRemindersForMonth(
          userId,
          today,
          DEFAULT_TIMEZONE,
        );

        if (reminders.length === 0) {
          aiResponse = "You have no reminders scheduled for this month.";
        } else {
          // Group reminders by day
          const remindersByDay = {};
          reminders.forEach((reminder) => {
            const day = moment(reminder.scheduledTime)
              .tz(reminder.timezone)
              .format("dddd, MMMM D");
            if (!remindersByDay[day]) {
              remindersByDay[day] = [];
            }
            remindersByDay[day].push(reminder);
          });

          // Format the response
          aiResponse = `📅 Your schedule for ${moment().format("MMMM YYYY")}:\n\n`;

          for (const day in remindersByDay) {
            aiResponse += `*${day}*\n`;
            remindersByDay[day].forEach((reminder, i) => {
              const time = moment(reminder.scheduledTime)
                .tz(reminder.timezone)
                .format("h:mm A");
              aiResponse += `${i + 1}. ${time}: ${reminder.message} (${reminder.category})\n`;
            });
            aiResponse += "\n";
          }
        }
      } else if (userIntent.intent === "list_reminders") {
        // Handle request to list reminders
        const reminders = await Reminder.find({
          userId,
          isCompleted: false,
          status: { $ne: "completed" },
          type: "standard",
        }).sort({ scheduledTime: 1 });

        if (reminders.length === 0) {
          aiResponse = "You have no active reminders.";
        } else {
          aiResponse =
            "📋 Your active reminders:\n\n" +
            reminders
              .map((r, i) => {
                const time = moment(r.scheduledTime)
                  .tz(r.timezone)
                  .format("ddd, MMM D, YYYY [at] h:mm A z");
                const statusIndicator =
                  r.status === "paused" ? " [PAUSED]" : "";
                return `${i + 1}. "${r.message}" - ${time}${r.isRecurring ? ` (recurring ${r.recurringPattern})` : ""}${statusIndicator} (${r.category})`;
              })
              .join("\n\n");
        }
      } else if (userIntent.intent === "upcoming_events") {
        // Handle request for upcoming events (today and future)
        const now = moment().tz(DEFAULT_TIMEZONE);
        const future = moment().tz(DEFAULT_TIMEZONE).add(30, "days"); // Look 30 days ahead

        const reminders = await Reminder.find({
          userId,
          scheduledTime: { $gte: now.toDate() },
          status: { $ne: "completed" },
          type: "standard",
        })
          .sort({ scheduledTime: 1 })
          .limit(10); // Limit to 10 upcoming reminders

        if (reminders.length === 0) {
          aiResponse = "You have no upcoming reminders scheduled.";
        } else {
          // Group reminders by day
          const remindersByDay = {};
          reminders.forEach((reminder) => {
            const day = moment(reminder.scheduledTime)
              .tz(reminder.timezone)
              .format("dddd, MMMM D");
            if (!remindersByDay[day]) {
              remindersByDay[day] = [];
            }
            remindersByDay[day].push(reminder);
          });

          // Format the response
          aiResponse = `📅 Your upcoming schedule:\n\n`;

          for (const day in remindersByDay) {
            aiResponse += `*${day}*\n`;
            remindersByDay[day].forEach((reminder, i) => {
              const time = moment(reminder.scheduledTime)
                .tz(reminder.timezone)
                .format("h:mm A");
              aiResponse += `${i + 1}. ${time}: ${reminder.message} (${reminder.category})\n`;
            });
            aiResponse += "\n";
          }
        }
      } else if (userIntent.intent === "last_reminder") {
        // Handle request for the user's most recent reminder
        const lastReminder = await Reminder.findOne({
          userId,
          status: { $ne: "completed" },
          type: "standard",
        }).sort({ createdAt: -1 }); // Sort by creation time, most recent first

        if (!lastReminder) {
          aiResponse = "You have no active reminders.";
        } else {
          const time = moment(lastReminder.scheduledTime)
            .tz(lastReminder.timezone)
            .format("ddd, MMM D, YYYY [at] h:mm A z");
          const recurringInfo = lastReminder.isRecurring
            ? ` (recurring ${lastReminder.recurringPattern})`
            : "";
          const statusInfo =
            lastReminder.status === "paused" ? " [PAUSED]" : "";

          aiResponse = `Your most recent reminder is:\n\n"${lastReminder.message}" scheduled for ${time}${recurringInfo}${statusInfo} (Category: ${lastReminder.category})`;
        }
      } 
      // ACTION INTENTS - Process user's requests to make changes
      else if (
        userIntent.intent === "set_reminder" &&
        userIntent.confidence >= 0.8
      ) {
        // Double-check that this is actually a creation request, not a query
        const createTerms = ["add", "create", "set", "remind me", "schedule", "make"];
        const isExplicitCreate = createTerms.some(term => 
          userMessageContent.toLowerCase().includes(term)
        );
        
        if (!isExplicitCreate && userIntent.confidence < 0.95) {
          // If not explicitly asking to create something and confidence isn't very high,
          // treat as a query instead (better to show info than create unwanted events)
          console.log("Overriding to query intent due to lack of explicit creation terms");
          
          // Try to determine what the user might be asking about
          if (userMessageContent.toLowerCase().includes("today")) {
            // Call the today's reminders query handler
            const today = moment().tz(DEFAULT_TIMEZONE).toDate();
            const reminders = await getRemindersForDay(userId, today, DEFAULT_TIMEZONE);
            
            if (reminders.length === 0) {
              aiResponse = "You have no reminders scheduled for today.";
            } else {
              aiResponse = `📆 Your schedule for today (${moment().format("dddd, MMMM D")}):\n\n` +
                reminders.map((r, i) => {
                  const time = moment(r.scheduledTime).tz(r.timezone).format("h:mm A");
                  return `${i + 1}. ${time}: ${r.message} (${r.category})`;
                }).join("\n\n");
            }
          } else {
            // Default to showing all reminders
            const reminders = await Reminder.find({
              userId,
              isCompleted: false,
              status: { $ne: "completed" },
              type: "standard",
            }).sort({ scheduledTime: 1 });
            
            if (reminders.length === 0) {
              aiResponse = "You have no active reminders.";
            } else {
              aiResponse = "📋 Your active reminders:\n\n" +
                reminders.map((r, i) => {
                  const time = moment(r.scheduledTime).tz(r.timezone).format("ddd, MMM D, YYYY [at] h:mm A z");
                  return `${i + 1}. "${r.message}" - ${time} (${r.category})`;
                }).join("\n\n");
            }
          }
        } else {
          // Handle reminder creation intent
          try {
            const reminderDetails = await extractReminderDetails(userMessageContent);
            console.log("Extracted reminder details:", reminderDetails);

            if (
              reminderDetails &&
              reminderDetails.time &&
              reminderDetails.message
            ) {
              // Create the reminder with AI-detected category
              const reminder = await createReminder(
                userId,
                reminderDetails.message,
                reminderDetails.time,
                reminderDetails.timezone || DEFAULT_TIMEZONE,
                reminderDetails.isRecurring,
                reminderDetails.recurringPattern,
                reminderDetails.category, // Use the category detected by AI
              );

              // Format the time in the user's timezone
              const formattedTime = moment(reminderDetails.time)
                .tz(reminderDetails.timezone || DEFAULT_TIMEZONE)
                .format("ddd, MMM D, YYYY [at] h:mm A z");

              if (reminderDetails.isRecurring) {
                aiResponse = `✅ Recurring reminder set: I'll remind you about "${reminderDetails.message}" ${reminderDetails.recurringPattern}, starting ${formattedTime} (Category: ${reminderDetails.category})`;
              } else {
                aiResponse = `✅ Reminder set: I'll remind you about "${reminderDetails.message}" on ${formattedTime} (Category: ${reminderDetails.category})`;
              }

              // Schedule the exact reminder job
              scheduleReminderJob(reminder);
            } else {
              aiResponse =
                "I couldn't understand when and what to remind you about. Could you try again with a specific time and message?";
            }
          } catch (error) {
            console.error("Error processing reminder:", error);
            aiResponse =
              "I had trouble setting your reminder. Please try again with a specific time and message.";
          }
        }
      } else if (
        userIntent.intent === "cancel_reminder" &&
        userIntent.confidence >= 0.7
      ) {
        // Handle request to cancel a reminder
        try {
          const reminderToCancel = await identifyReminderToCancel(
            userId,
            userMessageContent,
            userIntent,
          );
          if (reminderToCancel) {
            await Reminder.findByIdAndDelete(reminderToCancel._id);
            aiResponse = `✅ Canceled reminder: "${reminderToCancel.message}"`;

            // Also cancel any scheduled job
            const jobName = `reminder_${reminderToCancel._id}`;
            const existingJob = schedule.scheduledJobs[jobName];
            if (existingJob) {
              existingJob.cancel();
            }
          } else {
            aiResponse =
              "I couldn't identify which reminder you want to cancel. Please try 'Show my reminders' first and then specify which one to cancel.";
          }
        } catch (error) {
          console.error("Error canceling reminder:", error);
          aiResponse =
            "I had trouble canceling your reminder. Please try listing your reminders first.";
        }
      }
      // Process other intent types... 
      // [rest of intent handling code remains unchanged]
      else {
        // Handle as a general message using Gemini
        aiResponse = await processMessageWithAI(
          conversation,
          mediaType,
          mediaUrl,
        );
      }

      // Add AI response to history
      conversation.messages.push({
        role: "assistant",
        content: aiResponse,
        mediaType: "text",
      });
      conversation.lastInteraction = new Date();
      await conversation.save();

      // Send the response back to the user
      await sendMessage(userId, aiResponse, messages.id);

      // Log the received message for debugging
      console.log(JSON.stringify(messages, null, 2));
    }

    res.status(200).send("Webhook processed");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal Server Error");
  }
});

/**
 * Detect the user's intent from their message
 * @param {string} text - User message
 * @returns {Promise<Object>} - Intent and confidence score
 */
async function detectUserIntent(text) {
  try {
    // The LLM will be our primary method for intent detection
    // We'll provide clear examples that distinguish between queries and actions
    const prompt = `
      You are an advanced intent classifier for a WhatsApp personal assistant bot with calendar and reminder capabilities.
      Your most important job is to correctly distinguish between:
      1. QUERIES about existing information (user wants to VIEW or GET information)
      2. ACTIONS that create/modify/delete information (user wants to CHANGE something)

      Analyze this user message in great detail and determine the most likely intent.

      Message: "${text}"

      POSSIBLE INTENTS:
      - set_reminder: User wants to CREATE a new reminder, alarm, or calendar event
      - list_reminders: User wants to SEE a list of all their active reminders
      - cancel_reminder: User wants to CANCEL or DELETE a specific reminder
      - pause_reminder: User wants to TEMPORARILY PAUSE a recurring reminder
      - resume_reminder: User wants to RESUME a previously paused reminder
      - daily_briefing: User wants to receive a daily summary of their schedule
      - query_today: User is ASKING ABOUT today's events, schedule or activities
      - query_tomorrow: User is specifically ASKING ABOUT tomorrow's events/schedule
      - query_week: User is ASKING ABOUT events for this week
      - query_month: User is ASKING ABOUT events for this month
      - query_category: User is ASKING ABOUT reminders of a specific category
      - upcoming_events: User is ASKING ABOUT all their future scheduled events
      - last_reminder: User is ASKING ABOUT their most recent reminder or event
      - update_reminder: User wants to MODIFY an existing reminder or event
      - general_query: User is asking a general question unrelated to reminders

      CRITICALLY IMPORTANT GUIDELINES:
      1. When user asks "What are my events today?" or "What's on my schedule?" or "What do I have today?", this is ALWAYS a query_today intent
      2. When user says things like "show all events", "list my reminders", "what do I have scheduled", these are VIEWING intents, NOT creation intents
      3. ONLY classify as "set_reminder" if user is CLEARLY trying to CREATE something new (e.g., "add a reminder", "create a new event", "set an alarm")
      4. When ANY DOUBT exists between query vs. creation, ALWAYS prefer the query intent
      5. General questions about today's events or schedule should be query_today with high confidence

      EXAMPLES OF QUERY INTENTS (not creating anything):
      - "What do I have today?" => query_today
      - "What are my events for today?" => query_today
      - "Show me today's schedule" => query_today
      - "What's happening today?" => query_today
      - "What events do I have today?" => query_today
      - "Do I have anything today?" => query_today
      - "What all the events today?" => query_today
      - "What all the events I have today?" => query_today

      EXAMPLES OF CREATION INTENTS (explicitly creating new items):
      - "Add a new event called meeting at 3pm" => set_reminder
      - "Create a reminder for my doctor's appointment" => set_reminder
      - "Set an alarm for 7am tomorrow" => set_reminder
      - "Remind me to take medicine at 8pm" => set_reminder

      Response format (JSON only):
      {
        "intent": "selected_intent_from_the_list",
        "confidence": confidence_score_between_0_and_1,
        "category": extracted_category_if_query_category_intent_or_null,
        "explanation": brief_explanation_of_why_you_chose_this_intent
      }
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Parse the JSON from the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log("Failed to extract JSON from intent detection response");
      return { intent: "general_query", confidence: 1.0, category: null };
    }

    try {
      const parsedResult = JSON.parse(jsonMatch[0]);
      console.log(
        `Intent detection: ${parsedResult.intent} (${parsedResult.confidence}) - ${parsedResult.explanation || "No explanation"}`
      );

      // Apply additional safeguards - if the intent is an action with less than very high confidence
      // and the message looks like a query, override to the appropriate query intent
      if (
        ["set_reminder", "update_reminder", "cancel_reminder"].includes(parsedResult.intent) && 
        parsedResult.confidence < 0.9
      ) {
        // Simple heuristic to catch common query phrases that shouldn't be actions
        const queryPhrases = [
          "what", "show", "list", "tell me", "do i have", "is there", 
          "are there", "when is", "when are", "how many"
        ];
        
        const lowerText = text.toLowerCase();
        for (const phrase of queryPhrases) {
          if (lowerText.includes(phrase)) {
            console.log(`Overriding to query intent because message contains query phrase: ${phrase}`);
            
            // Determine which query intent is most appropriate
            let queryIntent = "general_query";
            if (lowerText.includes("today")) {
              queryIntent = "query_today";
            } else if (lowerText.includes("tomorrow")) {
              queryIntent = "query_tomorrow";
            } else if (lowerText.includes("week")) {
              queryIntent = "query_week";
            } else if (lowerText.includes("month")) {
              queryIntent = "query_month";
            } else {
              queryIntent = "list_reminders";
            }
            
            return {
              intent: queryIntent,
              confidence: 0.95, // High confidence override
              category: null,
              explanation: `Override: Message contains query phrase '${phrase}' but was classified as an action intent`
            };
          }
        }
      }

      return {
        intent: parsedResult.intent,
        confidence: parsedResult.confidence,
        category: parsedResult.category || null,
        explanation: parsedResult.explanation || null
      };
    } catch (parseError) {
      console.error("Error parsing intent JSON:", parseError);
      return { intent: "general_query", confidence: 1.0, category: null };
    }
  } catch (error) {
    console.error("Error detecting intent:", error);
    // Default to general query if we can't detect intent
    return { intent: "general_query", confidence: 1.0, category: null };
  }
}

/**
 * Extract reminder details from natural language text
 * @param {string} text - User message containing reminder request
 * @returns {Promise<Object>} - Extracted reminder details
 */
async function extractReminderDetails(text) {
  try {
    // First, verify this is actually a reminder creation request
    // and not a query about existing reminders
    const isActuallyReminder = await validateReminderRequest(text);
    if (!isActuallyReminder.isReminder) {
      console.log(`Text rejected as reminder: ${isActuallyReminder.reason}`);
      return null;
    }

    // Get current date in a clear, unambiguous format
    const now = moment().tz(DEFAULT_TIMEZONE);
    const currentYear = now.year();
    const currentDate = now.format("YYYY-MM-DD");
    const currentTime = now.format("HH:mm:ss");
    const formattedNow = now.format("dddd, MMMM D, YYYY [at] h:mm A z");

    // Use Gemini to extract detailed reminder information with explicit current date details
    const prompt = `
      You are an intelligent reminder extraction system for a personal assistant bot.
      Extract detailed reminder information from this text: "${text}"

      FORMAT YOUR RESPONSE AS VALID JSON ONLY like this:
      {
        "message": "the extracted reminder message",
        "time": "the exact date and time in ISO format",
        "timezone": "the timezone if specified, or null",
        "isRecurring": boolean indicating if this is a recurring reminder,
        "recurringPattern": "description of recurrence pattern if applicable, or null",
        "category": "the most appropriate category based on the message content"
      }

      CATEGORIES:
      Choose the most appropriate category from:
      - "work" (job-related tasks, meetings, deadlines, projects)
      - "personal" (personal appointments, social events, family matters)
      - "health" (medications, doctor visits, workouts, health-related activities)
      - "finance" (bills, payments, financial deadlines, banking)
      - "other" (anything that doesn't fit the above categories)

      REMINDER CONTEXT RULES:
      - Today's date is ${currentDate} (${formattedNow})
      - Current year is ${currentYear}
      - For relative times like "today", "tomorrow", "next week", convert to absolute date and time
      - Default timezone is IST (Asia/Kolkata) unless otherwise specified
      - For "today" references always use today's date (${currentDate}) with the correct year ${currentYear}
      - If no specific time is mentioned for today, use the next appropriate time
      - If date is missing, use the next occurrence
      - Handle recurring patterns like "daily", "every Monday", "weekdays at 9am", etc.

      EXAMPLES:
      - "Remind me about dinner today at 7pm" → time should be "${currentDate}T19:00:00+05:30", category "personal"
      - "Set reminder for meeting tomorrow" → time should be "${moment().add(1, "day").format("YYYY-MM-DD")}T09:00:00+05:30", category "work"
      - "Remind me to take my medication every day at 9am" → isRecurring: true, recurringPattern: "daily", category "health"
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Parse the JSON from the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Could not extract JSON from response");
    }

    const parsedResult = JSON.parse(jsonMatch[0]);

    // Ensure timezone is valid or set to default
    if (!parsedResult.timezone || !moment.tz.zone(parsedResult.timezone)) {
      parsedResult.timezone = DEFAULT_TIMEZONE;
    }

    // Validate and fix the parsed date if needed
    let reminderTime = moment(parsedResult.time).tz(parsedResult.timezone);

    // If the extracted date seems to be using an incorrect year (not current year)
    // for "today" references, fix it
    const todayReference = text.toLowerCase().includes("today");
    if (todayReference && reminderTime.year() !== currentYear) {
      console.log(
        `Fixing incorrect year in reminder: ${reminderTime.year()} → ${currentYear}`,
      );
      reminderTime.year(currentYear);
      parsedResult.time = reminderTime.toISOString();
    }

    console.log(
      `Parsed reminder time: ${reminderTime.format("YYYY-MM-DD HH:mm:ss Z")}`,
    );
    console.log(`Detected category: ${parsedResult.category || "other"}`);

    return {
      message: parsedResult.message,
      time: reminderTime.toDate(),
      timezone: parsedResult.timezone,
      isRecurring: !!parsedResult.isRecurring,
      recurringPattern: parsedResult.recurringPattern || null,
      category: parsedResult.category || "other",
    };
  } catch (error) {
    console.error("Error extracting reminder details:", error);
    throw error;
  }
}

/**
 * Validate whether a message is actually requesting to create a reminder
 * @param {string} text - User message to validate
 * @returns {Promise<Object>} - Whether it's a reminder creation request
 */
async function validateReminderRequest(text) {
  try {
    // Check for explicit reminder creation phrases
    const creationTerms = [
      /remind me to/i, 
      /set (a|an) reminder/i, 
      /create (a|an) reminder/i,
      /add (a|an) reminder/i,
      /schedule (a|an|my)/i,
      /add (to|an) event/i,
      /put (in|on) my calendar/i
    ];
    
    for (const pattern of creationTerms) {
      if (pattern.test(text)) {
        return { isReminder: true, confidence: 0.95 };
      }
    }
    
    // Check for question words that suggest this is a query, not a creation
    const queryWords = ["what", "when", "where", "how", "do i have", "is there", "are there"];
    for (const word of queryWords) {
      if (text.toLowerCase().includes(word)) {
        return { 
          isReminder: false, 
          confidence: 0.9,
          reason: `Contains query word "${word}" which suggests this is a question, not a reminder creation request`
        };
      }
    }
    
    // If no clear indicators, use Gemini for more nuanced understanding
    const prompt = `
      Analyze this message and determine if the user is clearly trying to CREATE A NEW reminder/event 
      (NOT asking about existing ones):
      
      "${text}"
      
      Return ONLY a valid JSON with these fields:
      {
        "isReminder": boolean indicating if user wants to create a new reminder,
        "confidence": number between 0 and 1,
        "reason": brief explanation for your decision
      }
      
      EXAMPLES:
      - "Remind me to call mom" → {"isReminder": true, "confidence": 0.95, "reason": "User explicitly asks to be reminded"}
      - "What are my events today?" → {"isReminder": false, "confidence": 0.98, "reason": "User is asking about existing events"}
      - "What events do I have?" → {"isReminder": false, "confidence": 0.97, "reason": "User is querying existing events"}
      - "Today's events" → {"isReminder": false, "confidence": 0.85, "reason": "Ambiguous but likely a query about existing events"}
    `;
    
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();
    
    // Parse the JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Default to false if response can't be parsed
      return { isReminder: false, confidence: 0.6, reason: "Failed to parse validation response" };
    }
    
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error("Error validating reminder request:", error);
    // Default to false in case of error - safer not to create reminder if unclear
    return { isReminder: false, confidence: 0.8, reason: "Error in validation process" };
  }
}

/**
 * Create a new reminder
 * @param {string} userId - User's phone number
 * @param {string} message - Reminder message
 * @param {Date} scheduledTime - When to send the reminder
 * @param {string} timezone - User's timezone
 * @param {boolean} isRecurring - Whether this is a recurring reminder
 * @param {string} recurringPattern - Description of recurrence pattern
 * @param {string} category - Reminder category
 * @param {string} status - Reminder status
 * @param {string} type - Reminder type
 * @returns {Promise<Document>} - Created reminder
 */
async function createReminder(
  userId,
  message,
  scheduledTime,
  timezone = DEFAULT_TIMEZONE,
  isRecurring = false,
  recurringPattern = null,
  category = "other",
  status = "active",
  type = "standard",
) {
  const reminder = new Reminder({
    userId,
    message,
    scheduledTime,
    timezone,
    isRecurring,
    recurringPattern,
    category,
    status,
    type,
    isPaused: status === "paused",
  });
  return await reminder.save();
}

/**
 * Schedule a specific job for a reminder
 * @param {Document} reminder - The reminder document to schedule
 */
async function scheduleReminderJob(reminder) {
  try {
    // Don't schedule paused reminders
    if (reminder.isPaused || reminder.status === "paused") {
      console.log(`Skipping scheduling paused reminder: ${reminder.message}`);
      return;
    }

    const scheduledTime = moment(reminder.scheduledTime).toDate();
    const jobName = `reminder_${reminder._id}`;

    // Cancel any existing job with this ID
    const existingJob = schedule.scheduledJobs[jobName];
    if (existingJob) {
      existingJob.cancel();
    }

    // Schedule one-time job for this specific reminder
    schedule.scheduleJob(jobName, scheduledTime, async function () {
      console.log(
        `Executing scheduled reminder: ${reminder.message} (Type: ${reminder.type})`,
      );

      // Only proceed if the reminder is still active
      const currentReminder = await Reminder.findById(reminder._id);
      if (
        !currentReminder ||
        currentReminder.isCompleted ||
        currentReminder.isPaused
      ) {
        return;
      }

      // Handle different types of reminders
      if (currentReminder.type === "daily_briefing") {
        // Handle daily briefing type
        await handleDailyBriefing(currentReminder);
      } else {
        // Handle standard reminder type
        await sendMessage(
          currentReminder.userId,
          `⏰ REMINDER: ${currentReminder.message}`,
        );

        // Handle recurring reminders
        if (currentReminder.isRecurring) {
          // Calculate next occurrence and create a new reminder
          const nextTime = calculateNextOccurrence(
            currentReminder.scheduledTime,
            currentReminder.recurringPattern,
            currentReminder.timezone,
          );

          if (nextTime) {
            const newReminder = await createReminder(
              currentReminder.userId,
              currentReminder.message,
              nextTime,
              currentReminder.timezone,
              true,
              currentReminder.recurringPattern,
              currentReminder.category,
              currentReminder.status,
              currentReminder.type,
            );

            // Schedule the next occurrence
            scheduleReminderJob(newReminder);
          }
        }

        // Mark current one as completed
        currentReminder.isCompleted = true;
        currentReminder.status = "completed";
        await currentReminder.save();

        console.log(
          `Sent reminder to ${currentReminder.userId}: ${currentReminder.message}`,
        );
      }
    });

    console.log(
      `Scheduled ${reminder.type} reminder "${reminder.message}" for ${scheduledTime}`,
    );
  } catch (error) {
    console.error("Error scheduling reminder job:", error);
  }
}

/**
 * Calculate the next occurrence for a recurring reminder
 * @param {Date} currentTime - The current occurrence time
 * @param {string} pattern - Recurrence pattern description
 * @param {string} timezone - User's timezone
 * @returns {Date|null} - Next occurrence time or null if pattern invalid
 */
function calculateNextOccurrence(currentTime, pattern, timezone) {
  try {
    const current = moment(currentTime).tz(timezone);
    let next = null;

    // Simple daily pattern
    if (pattern.includes("daily") || pattern.includes("every day")) {
      next = current.clone().add(1, "day");
    }
    // Weekly patterns
    else if (pattern.includes("weekly") || pattern.includes("every week")) {
      next = current.clone().add(1, "week");
    }
    // Monthly patterns
    else if (pattern.includes("monthly") || pattern.includes("every month")) {
      next = current.clone().add(1, "month");
    }
    // Specific days of week
    else if (pattern.includes("every Monday")) {
      next = current.clone().add(1, "week").day(1); // 1 = Monday
    } else if (pattern.includes("every Tuesday")) {
      next = current.clone().add(1, "week").day(2);
    } else if (pattern.includes("every Wednesday")) {
      next = current.clone().add(1, "week").day(3);
    } else if (pattern.includes("every Thursday")) {
      next = current.clone().add(1, "week").day(4);
    } else if (pattern.includes("every Friday")) {
      next = current.clone().add(1, "week").day(5);
    } else if (pattern.includes("every Saturday")) {
      next = current.clone().add(1, "week").day(6);
    } else if (pattern.includes("every Sunday")) {
      next = current.clone().add(1, "week").day(0);
    }
    // Weekdays pattern
    else if (pattern.includes("weekday") || pattern.includes("every weekday")) {
      next = current.clone().add(1, "day");
      // Skip weekend days
      if (next.day() === 6) {
        // Saturday
        next.add(2, "days");
      } else if (next.day() === 0) {
        // Sunday
        next.add(1, "day");
      }
    }
    // Weekend pattern
    else if (pattern.includes("weekend") || pattern.includes("every weekend")) {
      next = current.clone();
      if (current.day() === 6) {
        // If Saturday, go to next Sunday
        next.add(1, "day");
      } else if (current.day() === 0) {
        // If Sunday, go to next Saturday
        next.add(6, "days");
      } else {
        // Weekday, go to next Saturday
        next.day(6); // Next Saturday
      }
    } else {
      // Default to daily if pattern not recognized
      next = current.clone().add(1, "day");
    }

    return next.toDate();
  } catch (error) {
    console.error("Error calculating next occurrence:", error);
    return null;
  }
}

/**
 * Identify which reminder to cancel from user message
 * @param {string} userId - User's phone number
 * @param {string} message - User message about canceling
 * @param {Object} intentDetails - Additional intent details like itemNumber or itemText
 * @returns {Promise<Document|null>} - Reminder to cancel
 */
async function identifyReminderToCancel(userId, message, intentDetails = {}) {
  // Get all user's active reminders
  const reminders = await Reminder.find({
    userId,
    isCompleted: false,
  });

  if (reminders.length === 0) {
    return null;
  }

  if (reminders.length === 1) {
    // If only one reminder exists, return it
    return reminders[0];
  }

  // First check for day and position pattern (common in schedule listing replies)
  const dayPositionInfo = extractDayAndPosition(message);
  if (dayPositionInfo.position) {
    console.log(
      `Extracted position ${dayPositionInfo.position} and day ${dayPositionInfo.day || "any"} from message`,
    );
    const reminderByPosition = await findReminderByPositionInDay(
      userId,
      dayPositionInfo.position,
      dayPositionInfo.day,
    );

    if (reminderByPosition) {
      console.log(
        `Found reminder by position: "${reminderByPosition.message}"`,
      );
      return reminderByPosition;
    }
  }

  // If we have an item number from the intent detection, use it directly
  if (
    intentDetails.itemNumber &&
    intentDetails.itemNumber > 0 &&
    intentDetails.itemNumber <= reminders.length
  ) {
    console.log(
      `Canceling reminder by item number: ${intentDetails.itemNumber}`,
    );
    return reminders[intentDetails.itemNumber - 1]; // Convert to 0-based index
  }

  // If we have specific item text, try to match it against reminder messages
  if (intentDetails.itemText) {
    console.log(
      `Trying to match reminder with text: "${intentDetails.itemText}"`,
    );
    // Normalize both the search text and reminder messages to lowercase and remove extra whitespace
    const normalizedSearchText = intentDetails.itemText
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");

    // Find the best matching reminder
    const matchedReminder = reminders.find((reminder) => {
      const normalizedMessage = reminder.message
        .toLowerCase()
        .trim()
        .replace(/\s+/g, " ");
      return (
        normalizedMessage.includes(normalizedSearchText) ||
        normalizedSearchText.includes(normalizedMessage)
      );
    });

    if (matchedReminder) {
      console.log(`Found matching reminder: "${matchedReminder.message}"`);
      return matchedReminder;
    }
  }

  // Use Gemini to identify which reminder to cancel
  const prompt = `
    User wants to cancel a reminder with this message: "${message}"

    Here are their active reminders:
    ${reminders
      .map((r, i) => {
        const time = moment(r.scheduledTime)
          .tz(r.timezone)
          .format("ddd, MMM D, YYYY [at] h:mm A z");
        return `${i + 1}. "${r.message}" at ${time}${r.isRecurring ? ` (recurring ${r.recurringPattern})` : ""}`;
      })
      .join("\n")}

    Which reminder (by number) is the user most likely trying to cancel? Return just the number.
  `;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const response = result.response.text().trim();

    // Extract the number from the response
    const numberMatch = response.match(/\d+/);
    if (!numberMatch) {
      return null;
    }

    const reminderIndex = parseInt(numberMatch[0]) - 1;
    if (reminderIndex >= 0 && reminderIndex < reminders.length) {
      return reminders[reminderIndex];
    }

    return null;
  } catch (error) {
    console.error("Error identifying reminder to cancel:", error);
    return null;
  }
}

/**
 * Get or create conversation for a user
 * @param {string} userId - The user's phone number
 * @returns {Promise<Document>} - Mongoose document with conversation
 */
async function getOrCreateConversation(userId) {
  let conversation = await Conversation.findOne({ userId });

  if (!conversation) {
    conversation = new Conversation({
      userId,
      messages: [],
      lastInteraction: new Date(),
    });
  }

  return conversation;
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
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      },
    });

    // Get the actual media content
    const mediaData = await axios({
      url: response.data.url,
      method: "get",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      },
      responseType: "arraybuffer",
    });

    // Save the media locally
    const fileExtension = response.data.mime_type.split("/")[1];
    const fileName = `${Date.now()}.${fileExtension}`;
    const filePath = path.join(__dirname, "uploads", fileName);

    // Ensure uploads directory exists
    if (!fs.existsSync(path.join(__dirname, "uploads"))) {
      fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
    }

    fs.writeFileSync(filePath, mediaData.data);

    return `/uploads/${fileName}`; // Return the local path
  } catch (error) {
    console.error("Error getting media:", error);
    return null;
  }
}

/**
 * Process message using Gemini AI with conversation context
 * @param {Document} conversation - The conversation document
 * @param {string} mediaType - Type of media (text, image, document)
 * @param {string} mediaUrl - URL to the media file (if any)
 * @returns {Promise<string>} - AI's response
 */
async function processMessageWithAI(conversation, mediaType, mediaUrl) {
  try {
    let model;

    // Get the most recent conversation history (last 5 messages)
    const recentMessages = conversation.messages.slice(-5).map((msg) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    }));

    // For context, use the last 3 messages as text
    const contextMessages = conversation.messages.slice(-3);
    const contextText = contextMessages
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join("\n");

    // Check if an event was already created from this image/document
    const eventAlreadyCreated = conversation.eventAlreadyCreated === true;
    
    // If we're processing an image or document
    if (mediaType === "image" || mediaType === "document") {
      // Use the Vision model for images and documents
      model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

      // Prepare content parts
      const contentParts = [];
      contentParts.push({
        text: `Previous conversation:\n${contextText}\n\nPlease analyze this and respond appropriately:${
          eventAlreadyCreated 
            ? "\n\nNOTE: I've already created an event from this image, so don't ask about adding it to the calendar." 
            : ""
        }`,
      });

      // Add the media if available
      if (mediaUrl) {
        const filePath = path.join(__dirname, mediaUrl);
        const mimeType =
          mediaType === "image" ? "image/jpeg" : "application/pdf";

        const fileData = await readFileAsync(filePath);
        contentParts.push({
          inlineData: {
            data: fileData.toString("base64"),
            mimeType,
          },
        });
      }

      // Generate content with vision model
      const result = await model.generateContent({
        contents: [{ role: "user", parts: contentParts }],
      });

      return result.response.text();
    } else {
      // Use standard Gemini Pro for text
      model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

      // Create a chat session
      const chat = model.startChat({
        history: recentMessages,
        generationConfig: {
          maxOutputTokens: 1000,
        },
      });

      // Get the user's last message
      const userMessage =
        conversation.messages[conversation.messages.length - 1].content;

      // Send message and get response
      const result = await chat.sendMessage(userMessage);
      return result.response.text();
    }
  } catch (error) {
    console.error("Error processing with AI:", error);
    return "I'm sorry, I encountered an error while processing your message. Please try again later.";
  }
}

/**
 * Send a text message to a WhatsApp user
 * @param {string} to - The recipient's phone number
 * @param {string} body - The message content
 * @param {string} messageId - Optional ID of message to reply to
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

    await axios({
      url: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      method: "post",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      data: JSON.stringify(data),
    });

    console.log(`Message sent successfully to ${to}`);
  } catch (error) {
    console.error(
      "Error sending message:",
      error.response ? error.response.data : error.message,
    );
  }
}

/**
 * Re-schedule all pending reminders from database (run at startup)
 */
async function rescheduleAllReminders() {
  try {
    const pendingReminders = await Reminder.find({
      isCompleted: false,
    });

    console.log(
      `Found ${pendingReminders.length} pending reminders to schedule`,
    );

    for (const reminder of pendingReminders) {
      scheduleReminderJob(reminder);
    }
  } catch (error) {
    console.error("Error rescheduling reminders:", error);
  }
}

// Clean up old conversations (older than 30 days)
async function cleanupOldConversations() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  try {
    const result = await Conversation.deleteMany({
      lastInteraction: { $lt: thirtyDaysAgo },
    });
    console.log(`Cleaned up ${result.deletedCount} old conversations`);
  } catch (error) {
    console.error("Error cleaning up old conversations:", error);
  }
}

// Clean up old completed reminders (older than 7 days)
async function cleanupOldReminders() {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  try {
    const result = await Reminder.deleteMany({
      isCompleted: true,
      scheduledTime: { $lt: sevenDaysAgo },
    });
    console.log(`Cleaned up ${result.deletedCount} old reminders`);
  } catch (error) {
    console.error("Error cleaning up old reminders:", error);
  }
}

// When server starts, reschedule all pending reminders
rescheduleAllReminders().then(() => {
  console.log("All pending reminders have been rescheduled");
});

// Run cleanups daily at midnight
schedule.scheduleJob("0 0 * * *", () => {
  cleanupOldConversations();
  cleanupOldReminders();
});

/**
 * Create a daily briefing reminder that will send a summary of the day's events
 * @param {string} userId - User's phone number
 * @param {Date} scheduledTime - Time to send daily briefing
 * @param {string} timezone - User's timezone
 * @returns {Promise<Document>} - Created reminder
 */
async function createDailyBriefingReminder(
  userId,
  scheduledTime,
  timezone = DEFAULT_TIMEZONE,
) {
  const reminder = new Reminder({
    userId,
    message: "Daily schedule briefing",
    scheduledTime,
    timezone,
    isRecurring: true,
    recurringPattern: "daily",
    category: "other",
    status: "active",
    type: "daily_briefing",
  });

  const savedReminder = await reminder.save();
  console.log(
    `Created daily briefing reminder for ${userId} at ${moment(scheduledTime).format("h:mm A")}`,
  );
  return savedReminder;
}

/**
 * Get reminders for a specific day
 * @param {string} userId - User's phone number
 * @param {Date} date - The date to query
 * @param {string} timezone - User's timezone
 * @returns {Promise<Array>} - Array of reminders
 */
async function getRemindersForDay(userId, date, timezone = DEFAULT_TIMEZONE) {
  const startOfDay = moment(date).tz(timezone).startOf("day").toDate();
  const endOfDay = moment(date).tz(timezone).endOf("day").toDate();

  return await Reminder.find({
    userId,
    scheduledTime: { $gte: startOfDay, $lte: endOfDay },
    status: { $ne: "completed" },
    type: "standard", // Exclude meta-reminders
  }).sort({ scheduledTime: 1 });
}

/**
 * Get reminders for a specific week
 * @param {string} userId - User's phone number
 * @param {Date} date - Any date in the target week
 * @param {string} timezone - User's timezone
 * @returns {Promise<Array>} - Array of reminders
 */
async function getRemindersForWeek(userId, date, timezone = DEFAULT_TIMEZONE) {
  const startOfWeek = moment(date).tz(timezone).startOf("week").toDate();
  const endOfWeek = moment(date).tz(timezone).endOf("week").toDate();

  return await Reminder.find({
    userId,
    scheduledTime: { $gte: startOfWeek, $lte: endOfWeek },
    status: { $ne: "completed" },
    type: "standard",
  }).sort({ scheduledTime: 1 });
}

/**
 * Get reminders for a specific month
 * @param {string} userId - User's phone number
 * @param {Date} date - Any date in the target month
 * @param {string} timezone - User's timezone
 * @returns {Promise<Array>} - Array of reminders
 */
async function getRemindersForMonth(userId, date, timezone = DEFAULT_TIMEZONE) {
  const startOfMonth = moment(date).tz(timezone).startOf("month").toDate();
  const endOfMonth = moment(date).tz(timezone).endOf("month").toDate();

  return await Reminder.find({
    userId,
    scheduledTime: { $gte: startOfMonth, $lte: endOfMonth },
    status: { $ne: "completed" },
    type: "standard",
  }).sort({ scheduledTime: 1 });
}

/**
 * Get reminders of a specific category
 * @param {string} userId - User's phone number
 * @param {string} category - Reminder category
 * @returns {Promise<Array>} - Array of reminders
 */
async function getRemindersByCategory(userId, category) {
  return await Reminder.find({
    userId,
    category,
    status: { $ne: "completed" },
    type: "standard",
  }).sort({ scheduledTime: 1 });
}

/**
 * Pause a reminder
 * @param {string} reminderId - ID of reminder to pause
 * @returns {Promise<Document|null>} - Updated reminder
 */
async function pauseReminder(reminderId) {
  const reminder = await Reminder.findById(reminderId);
  if (!reminder) return null;

  reminder.status = "paused";
  reminder.isPaused = true;
  reminder.lastUpdated = new Date();
  await reminder.save();

  // Cancel any scheduled job for this reminder
  const jobName = `reminder_${reminder._id}`;
  const existingJob = schedule.scheduledJobs[jobName];
  if (existingJob) {
    existingJob.cancel();
    console.log(
      `Cancelled scheduled job for paused reminder: ${reminder.message}`,
    );
  }

  return reminder;
}

/**
 * Resume a paused reminder
 * @param {string} reminderId - ID of reminder to resume
 * @returns {Promise<Document|null>} - Updated reminder
 */
async function resumeReminder(reminderId) {
  const reminder = await Reminder.findById(reminderId);
  if (!reminder) return null;

  reminder.status = "active";
  reminder.isPaused = false;
  reminder.lastUpdated = new Date();
  await reminder.save();

  // For recurring reminders that were paused, we need to calculate the next occurrence
  if (reminder.isRecurring) {
    // Get the next occurrence based on current time
    const now = moment().tz(reminder.timezone);
    let nextTime;

    // If it's a specific time-of-day reminder, maintain the time but update the date
    const reminderTime = moment(reminder.scheduledTime).tz(reminder.timezone);
    if (reminderTime.isBefore(now)) {
      // Create a new occurrence with the same time on the appropriate next day
      nextTime = calculateNextOccurrence(
        now.toDate(),
        reminder.recurringPattern,
        reminder.timezone,
      );
    } else {
      // Use the original time if it's still in the future
      nextTime = reminder.scheduledTime;
    }

    reminder.scheduledTime = nextTime;
    await reminder.save();
  }

  // Re-schedule the reminder
  scheduleReminderJob(reminder);

  return reminder;
}

/**
 * Generate a daily briefing message
 * @param {string} userId - User's phone number
 * @param {string} timezone - User's timezone
 * @returns {Promise<string>} - Briefing message
 */
async function generateDailyBriefing(userId, timezone = DEFAULT_TIMEZONE) {
  const today = moment().tz(timezone);
  const tomorrow = moment().tz(timezone).add(1, "day");

  // Get today's reminders
  const todayReminders = await getRemindersForDay(
    userId,
    today.toDate(),
    timezone,
  );

  // Get tomorrow's reminders
  const tomorrowReminders = await getRemindersForDay(
    userId,
    tomorrow.toDate(),
    timezone,
  );

  // Format the message
  let message = `🌞 *Good morning! Here's your daily briefing for ${today.format("dddd, MMMM D")}*\n\n`;

  if (todayReminders.length > 0) {
    message += "*TODAY'S SCHEDULE:*\n";
    todayReminders.forEach((reminder, index) => {
      const time = moment(reminder.scheduledTime).tz(timezone).format("h:mm A");
      message += `${index + 1}. ${time}: ${reminder.message}\n`;
    });
  } else {
    message += "*TODAY'S SCHEDULE:* No reminders for today\n";
  }

  message += "\n";

  if (tomorrowReminders.length > 0) {
    message += "*TOMORROW:*\n";
    tomorrowReminders.forEach((reminder, index) => {
      const time = moment(reminder.scheduledTime).tz(timezone).format("h:mm A");
      message += `${index + 1}. ${time}: ${reminder.message}\n`;
    });
  } else {
    message += "*TOMORROW:* No reminders scheduled\n";
  }

  return message;
}

/**
 * Handle the daily briefing when triggered
 * @param {Document} reminderDoc - The daily briefing reminder document
 */
async function handleDailyBriefing(reminderDoc) {
  try {
    const briefingMessage = await generateDailyBriefing(
      reminderDoc.userId,
      reminderDoc.timezone,
    );

    // Send the briefing to the user
    await sendMessage(reminderDoc.userId, briefingMessage);

    console.log(`Sent daily briefing to ${reminderDoc.userId}`);

    // If it's a recurring daily briefing, schedule the next one
    if (reminderDoc.isRecurring) {
      // Calculate next occurrence
      const nextTime = calculateNextOccurrence(
        reminderDoc.scheduledTime,
        reminderDoc.recurringPattern,
        reminderDoc.timezone,
      );

      if (nextTime) {
        const newReminder = await createReminder(
          reminderDoc.userId,
          reminderDoc.message,
          nextTime,
          reminderDoc.timezone,
          true,
          reminderDoc.recurringPattern,
          reminderDoc.category,
          "active",
          "daily_briefing",
        );

        // Schedule the next occurrence
        scheduleReminderJob(newReminder);
      }
    }

    // Mark current one as completed
    reminderDoc.isCompleted = true;
    reminderDoc.status = "completed";
    await reminderDoc.save();
  } catch (error) {
    console.error("Error handling daily briefing:", error);
  }
}

/**
 * Check if a text message contains event information
 * @param {string} text - Text message to check
 * @returns {Promise<Object>} - Whether text contains event info and confidence
 */
async function checkIfTextContainsEvent(text) {
  try {
    const prompt = `
      You are analyzing a text message to determine if it contains information about an event, meeting, appointment, 
      or any scheduled activity. This could be a forwarded message, invitation, or announcement.

      Text: "${text}"

      Analyze if this text contains:
      1. A specific date or time reference (today, tomorrow, next week, May 5th, etc.)
      2. An event name or type (meeting, party, appointment, ceremony, etc.)
      3. Any other indicators that this refers to a scheduled event

      Return ONLY a valid JSON response with the following fields:
      {
        "isEvent": boolean indicating if this contains event information,
        "confidence": number between 0 and 1 indicating confidence level,
        "reason": brief explanation of why you think this is or isn't an event
      }
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        isEvent: false,
        confidence: 0,
        reason: "Failed to extract JSON response",
      };
    }

    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error("Error checking if text contains event:", error);
    return { isEvent: false, confidence: 0, reason: "Error in analysis" };
  }
}

/**
 * Extract event details from a text message
 * @param {string} text - Text message to extract from
 * @returns {Promise<Object|null>} - Extracted event details or null
 */
async function extractEventFromText(text) {
  try {
    const now = moment().tz(DEFAULT_TIMEZONE);
    const currentYear = now.year();

    const prompt = `
      You are an AI assistant that extracts event details from text messages, invitations, or forwards.

      Analyze this text and extract detailed event information: "${text}"

      Format your response as ONLY valid JSON with these fields:
      {
        "eventName": "extracted event title or name",
        "eventDate": "ISO format date YYYY-MM-DD",
        "eventTime": "time of event (e.g., '7:00 PM', 'All day')",
        "eventLocation": "location of the event if mentioned",
        "eventDescription": "brief description or context of the event",
        "category": "work", "personal", "social" or "other"
      }

      IMPORTANT CONTEXT:
      - Today's date: ${now.format("YYYY-MM-DD")} (${now.format("dddd, MMMM D")})
      - Current year: ${currentYear}
      - Current time: ${now.format("h:mm A")}
      - Time zone: ${DEFAULT_TIMEZONE}

      EXTRACTION RULES:
      - For relative dates (today, tomorrow, next Monday), convert to actual date
      - ALWAYS include the year in the date, default to current year if not specified
      - Extract time in 12-hour format if available, or "All day" if no time
      - If multiple dates mentioned, choose the most likely event date
      - If details are ambiguous or missing, use your best judgment
      - Do not invent or add information not implied by the text
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log("Failed to extract event details from text");
      return null;
    }

    const eventDetails = JSON.parse(jsonMatch[0]);
    console.log("Extracted event details from text:", eventDetails);

    // Convert date string to Date object
    if (eventDetails.eventDate) {
      eventDetails.eventDate = new Date(eventDetails.eventDate);
    }

    return eventDetails;
  } catch (error) {
    console.error("Error extracting event from text:", error);
    return null;
  }
}

/**
 * Extract event details from an image or document
 * @param {string} mediaUrl - Path to the media file
 * @param {string} mediaType - Type of media (image or document)
 * @returns {Promise<Object|null>} - Extracted event details or null
 */
async function extractEventFromMedia(mediaUrl, mediaType) {
  try {
    const now = moment().tz(DEFAULT_TIMEZONE);
    const currentYear = now.year();

    // Read the file
    const filePath = path.join(__dirname, mediaUrl);
    const fileData = await readFileAsync(filePath);

    // Determine MIME type
    const mimeType = mediaType === "image" ? "image/jpeg" : "application/pdf";

    // Prepare prompt for Gemini Vision
    const prompt = `
      You are an AI assistant that extracts event information from ${mediaType}s.

      Carefully analyze this ${mediaType} and identify if it contains information about an event, meeting, 
      appointment, or any scheduled activity.

      If this ${mediaType} contains an event, extract the following details:
      - Event name or title
      - Date of the event
      - Time of the event
      - Location of the event
      - Organizer or host information
      - Any website or registration URL
      - Contact phone numbers
      - Any additional context like descriptions, sponsors, etc.

      Focus on key details like:
      - Event posters or flyers
      - Invitations
      - Calendar entries
      - Announcements
      - Any text that includes dates, times, and event descriptions

      Format your response as ONLY valid JSON with these fields:
      {
        "eventName": "extracted event title or name",
        "eventDate": "ISO format date YYYY-MM-DD",
        "eventTime": "time of event (e.g., '7:00 PM', 'All day')",
        "eventLocation": "location of the event if mentioned",
        "eventHost": "organizer or host of the event",
        "eventWebsite": "website URL if available",
        "eventContact": "contact information if available",
        "eventDescription": "brief description or context of the event",
        "category": "work", "personal", "social" or "other",
        "confidence": number between 0 and 1 indicating confidence level
      }

      If NO event information is found, return:
      {
        "eventFound": false
      }

      IMPORTANT CONTEXT:
      - Today's date: ${now.format("YYYY-MM-DD")} (${now.format("dddd, MMMM D")})
      - Current year: ${currentYear}

      EXTRACTION RULES:
      - ALWAYS include the year in the date, using the specified year or current year if not specified
      - Extract time in 12-hour format if available, or "All day" if no time
      - Be confident in your extraction but don't invent details not present in the ${mediaType}
    `;

    // Prepare the content for Gemini Vision
    const contentParts = [
      { text: prompt },
      {
        inlineData: {
          data: fileData.toString("base64"),
          mimeType,
        },
      },
    ];

    // Use Gemini Pro Vision to analyze the image/document
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent({
      contents: [{ role: "user", parts: contentParts }],
    });

    const responseText = result.response.text().trim();

    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log(`Failed to extract event details from ${mediaType}`);
      return null;
    }

    const parsedResponse = JSON.parse(jsonMatch[0]);

    // Check if an event was found
    if (parsedResponse.eventFound === false) {
      console.log(`No event information found in ${mediaType}`);
      return null;
    }

    // If we have an event, convert date string to Date object
    if (parsedResponse.eventDate) {
      parsedResponse.eventDate = new Date(parsedResponse.eventDate);
    }

    // Set default confidence if not provided
    if (!parsedResponse.confidence) {
      parsedResponse.confidence = 0.8;
    }

    console.log(`Extracted event details from ${mediaType}:`, parsedResponse);
    return parsedResponse;
  } catch (error) {
    console.error(`Error extracting event from ${mediaType}:`, error);
    return null;
  }
}

/**
 * Create a reminder from extracted event details
 * @param {string} userId - User's phone number
 * @param {Object} eventDetails - Extracted event details
 * @returns {Promise<Document>} - Created reminder
 */
async function createEventReminder(userId, eventDetails) {
  // Determine the reminder time
  let scheduledTime;
  if (
    eventDetails.eventTime &&
    eventDetails.eventTime.toLowerCase() !== "all day"
  ) {
    // Parse the time and set it on the event date
    const timeParts = eventDetails.eventTime.match(
      /(\d+)(?::(\d+))?\s*(am|pm)?/i,
    );
    if (timeParts) {
      const hours = parseInt(timeParts[1]);
      const minutes = timeParts[2] ? parseInt(timeParts[2]) : 0;
      const isPM = timeParts[3] && timeParts[3].toLowerCase() === "pm";

      scheduledTime = moment(eventDetails.eventDate).tz(DEFAULT_TIMEZONE);
      scheduledTime.hours(isPM && hours < 12 ? hours + 12 : hours);
      scheduledTime.minutes(minutes);
      scheduledTime.seconds(0);
    } else {
      // Default to noon if time format can't be parsed
      scheduledTime = moment(eventDetails.eventDate)
        .tz(DEFAULT_TIMEZONE)
        .hours(12)
        .minutes(0)
        .seconds(0);
    }
  } else {
    // For all-day events, set to 9 AM
    scheduledTime = moment(eventDetails.eventDate)
      .tz(DEFAULT_TIMEZONE)
      .hours(9)
      .minutes(0)
      .seconds(0);
  }

  // Set reminder message
  let reminderMessage = eventDetails.eventName;
  if (eventDetails.eventLocation) {
    reminderMessage += ` at ${eventDetails.eventLocation}`;
  }

  // Map detected category to allowed schema values
  // Valid categories in our schema: 'work', 'personal', 'health', 'finance', 'other'
  let mappedCategory = "other"; // default

  if (eventDetails.category) {
    const category = eventDetails.category.toLowerCase();

    // Direct matches
    if (["work", "personal", "health", "finance"].includes(category)) {
      mappedCategory = category;
    }
    // Map similar categories
    else if (
      ["social", "community", "charity", "fundraiser", "event"].includes(
        category,
      )
    ) {
      mappedCategory = "personal";
    } else if (
      ["medical", "wellness", "fitness", "exercise", "doctor"].includes(
        category,
      )
    ) {
      mappedCategory = "health";
    } else if (
      ["business", "meeting", "conference", "job", "professional"].includes(
        category,
      )
    ) {
      mappedCategory = "work";
    } else if (
      ["banking", "payment", "money", "investment", "bill"].includes(category)
    ) {
      mappedCategory = "finance";
    }
  }

  console.log(
    `Mapping category "${eventDetails.category}" to schema category "${mappedCategory}"`,
  );

  // Create the reminder
  try {
    const reminder = await createReminder(
      userId,
      reminderMessage,
      scheduledTime.toDate(),
      DEFAULT_TIMEZONE,
      false, // Not recurring by default
      null, // No recurring pattern
      mappedCategory,
      "active",
      "standard",
    );

    // Also store detailed event information in the event detection collection
    const eventDetection = new EventDetection({
      eventName: eventDetails.eventName,
      eventDate: eventDetails.eventDate,
      eventTime: eventDetails.eventTime,
      eventLocation: eventDetails.eventLocation || "",
      eventDescription: eventDetails.eventDescription || "",
      sourceType: eventDetails.sourceType || "text",
      confidence: eventDetails.confidence || 0.8,
    });

    await eventDetection.save();

    return reminder;
  } catch (error) {
    console.error("Error creating event reminder:", error);

    // If there's a validation error, try with the default category
    if (
      error.name === "ValidationError" &&
      error.errors &&
      error.errors.category
    ) {
      console.log(
        "Falling back to default category 'other' due to validation error",
      );

      const reminder = await createReminder(
        userId,
        reminderMessage,
        scheduledTime.toDate(),
        DEFAULT_TIMEZONE,
        false,
        null,
        "other", // Fallback to "other" category
        "active",
        "standard",
      );

      return reminder;
    }

    throw error;
  }
}

/**
 * Identify which reminder to update from user message
 * @param {string} userId - User's phone number
 * @param {string} message - User message about updating
 * @returns {Promise<Document|null>} - Reminder to update
 */
async function identifyReminderToUpdate(userId, message) {
  // Get all user's active reminders
  const reminders = await Reminder.find({
    userId,
    isCompleted: false,
    status: { $ne: "completed" },
  });

  if (reminders.length === 0) {
    return null;
  }

  if (reminders.length === 1) {
    // If only one reminder exists, return it
    return reminders[0];
  }

  // Use Gemini to identify which reminder to update
  const prompt = `
    User wants to update a reminder with this message: "${message}"

    Here are their active reminders:
    ${reminders
      .map((r, i) => {
        const time = moment(r.scheduledTime)
          .tz(r.timezone)
          .format("ddd, MMM D, YYYY [at] h:mm A z");
        return `${i + 1}. "${r.message}" at ${time}${r.isRecurring ? ` (recurring ${r.recurringPattern})` : ""}`;
      })
      .join("\n")}

    Which reminder (by number) is the user most likely trying to update? Return just the number.
  `;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const response = result.response.text().trim();

    // Extract the number from the response
    const numberMatch = response.match(/\d+/);
    if (!numberMatch) {
      return null;
    }

    const reminderIndex = parseInt(numberMatch[0]) - 1;
    if (reminderIndex >= 0 && reminderIndex < reminders.length) {
      return reminders[reminderIndex];
    }

    return null;
  } catch (error) {
    console.error("Error identifying reminder to update:", error);
    return null;
  }
}

/**
 * Extract update details from a user message
 * @param {string} message - User message about the update
 * @param {Document} existingReminder - The reminder to update
 * @returns {Promise<Object>} - Details to update
 */
async function extractUpdateDetails(message, existingReminder) {
  try {
    // Get current date in a clear format
    const now = moment().tz(DEFAULT_TIMEZONE);
    const currentYear = now.year();
    const currentDate = now.format("YYYY-MM-DD");
    const formattedNow = now.format("dddd, MMMM D, YYYY [at] h:mm A z");

    // Existing reminder details for context
    const existingTime = moment(existingReminder.scheduledTime).tz(
      existingReminder.timezone,
    );
    const existingTimeStr = existingTime.format("YYYY-MM-DD HH:mm:ss Z");

    // Use Gemini to extract update details
    const prompt = `
      You are an intelligent reminder update extraction system.

      The user wants to update this existing reminder:
      - Message: "${existingReminder.message}"
      - Current time: ${existingTimeStr}
      - Category: ${existingReminder.category}

      With this update request: "${message}"

      Extract what needs to be updated. FORMAT YOUR RESPONSE AS VALID JSON ONLY with these fields:
      {
        "message": "updated message if changed, or null if unchanged",
        "scheduledTime": "updated date and time in ISO format, or null if unchanged",
        "timezone": "updated timezone if specified, or null if unchanged",
        "isRecurring": boolean indicating if recurrence status changed, or null if unchanged,
        "recurringPattern": "updated recurrence pattern if changed, or null if unchanged",
        "category": "updated category if changed, or null if unchanged"
      }

      CONTEXT:
      - Today's date is ${currentDate} (${formattedNow})
      - Current year is ${currentYear}
      - Default timezone is IST (Asia/Kolkata)
      - For relative dates (today, tomorrow), convert to absolute date
      - Available categories: work, personal, health, finance, other

      EXAMPLES:
      - "Change the time to 7pm" → only scheduledTime changes, keep original date
      - "Move it to tomorrow" → only date changes, keep original time
      - "Change it to daily reminder" → isRecurring: true, recurringPattern: "daily"
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Parse the JSON from the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Could not extract JSON from response");
    }

    const parsedResult = JSON.parse(jsonMatch[0]);

    // Process updates
    const updates = {};

    // Handle message update
    if (parsedResult.message && parsedResult.message !== null) {
      updates.message = parsedResult.message;
    }

    // Handle scheduled time update
    if (parsedResult.scheduledTime && parsedResult.scheduledTime !== null) {
      // Parse the updated time
      let updatedTime = moment(parsedResult.scheduledTime).tz(
        existingReminder.timezone,
      );

      // Fix potential year issues with "today" references
      if (
        message.toLowerCase().includes("today") &&
        updatedTime.year() !== currentYear
      ) {
        console.log(
          `Fixing incorrect year in updated reminder: ${updatedTime.year()} → ${currentYear}`,
        );
        updatedTime.year(currentYear);
      }

      updates.scheduledTime = updatedTime.toDate();
    }

    // Handle timezone update
    if (parsedResult.timezone && parsedResult.timezone !== null) {
      // Validate timezone
      if (moment.tz.zone(parsedResult.timezone)) {
        updates.timezone = parsedResult.timezone;
      } else {
        updates.timezone = DEFAULT_TIMEZONE;
      }
    }

    // Handle recurring settings updates
    if (parsedResult.isRecurring !== null) {
      updates.isRecurring = !!parsedResult.isRecurring;
    }

    if (
      parsedResult.recurringPattern &&
      parsedResult.recurringPattern !== null
    ) {
      updates.recurringPattern = parsedResult.recurringPattern;
    }

    // Handle category update
    if (parsedResult.category && parsedResult.category !== null) {
      const validCategories = [
        "work",
        "personal",
        "health",
        "finance",
        "other",
      ];
      if (validCategories.includes(parsedResult.category)) {
        updates.category = parsedResult.category;
      }
    }

    // Update last modified time
    updates.lastUpdated = new Date();

    return updates;
  } catch (error) {
    console.error("Error extracting update details:", error);
    return null;
  }
}

/**
 * Apply updates to a reminder
 * @param {string} reminderId - ID of reminder to update
 * @param {Object} updates - Object with fields to update
 * @returns {Promise<Document>} - Updated reminder
 */
async function updateReminder(reminderId, updates) {
  try {
    const reminder = await Reminder.findById(reminderId);
    if (!reminder) {
      throw new Error("Reminder not found");
    }

    // Apply updates
    Object.keys(updates).forEach((key) => {
      reminder[key] = updates[key];
    });

    // Save the updated reminder
    await reminder.save();

    return reminder;
  } catch (error) {
    console.error("Error updating reminder:", error);
    throw error;
  }
}

/**
 * Store a detected event for later confirmation
 * @param {string} userId - User's phone number
 * @param {Object} eventDetails - The detected event details
 * @param {string} mediaSource - Source of the detection (image, document, text)
 * @returns {Promise<Document>} - Stored pending event
 */
async function storeDetectedEvent(userId, eventDetails, mediaSource = "image") {
  try {
    // Check if there's already a pending event with the same name
    const existingEvent = await PendingEvent.findOne({
      userId,
      "eventDetails.eventName": eventDetails.eventName,
      confirmed: false,
    });

    if (existingEvent) {
      // Update existing event
      existingEvent.eventDetails = eventDetails;
      existingEvent.detectedAt = new Date();
      existingEvent.mediaSource = mediaSource;
      return await existingEvent.save();
    } else {
      // Create new pending event
      const pendingEvent = new PendingEvent({
        userId,
        eventDetails,
        mediaSource,
        detectedAt: new Date(),
      });

      return await pendingEvent.save();
    }
  } catch (error) {
    console.error("Error storing detected event:", error);
    return null;
  }
}

/**
 * Handle user confirmation for adding a detected event
 * @param {string} userId - User's phone number
 * @param {string} message - User's confirmation message
 * @returns {Promise<Object>} - Result of the confirmation process
 */
async function handleEventConfirmation(userId, message) {
  try {
    // Check if there are any pending events for this user
    const pendingEvent = await PendingEvent.findOne({
      userId,
      confirmed: false,
    }).sort({ detectedAt: -1 });

    if (!pendingEvent) {
      return { success: false, message: "No pending events found to confirm" };
    }

    // Use AI to determine if the message is confirming or declining
    const confirmationIntent = await detectConfirmationIntent(message);

    if (confirmationIntent.isConfirming) {
      // Mark as confirmed
      pendingEvent.confirmed = true;
      await pendingEvent.save();

      // Create the actual reminder/event
      const eventReminder = await createEventReminder(
        userId,
        pendingEvent.eventDetails,
      );

      // Get day of week for the event date
      const eventDate = moment(pendingEvent.eventDetails.eventDate).tz(
        DEFAULT_TIMEZONE,
      );
      const dayOfWeek = eventDate.format("dddd");

      return {
        success: true,
        message: `✅ Added "${pendingEvent.eventDetails.eventName}" to your calendar for ${dayOfWeek}, ${eventDate.format("MMMM D, YYYY")} at ${pendingEvent.eventDetails.eventTime || "all day"} ${pendingEvent.eventDetails.eventLocation ? `at ${pendingEvent.eventDetails.eventLocation}` : ""}.`,
        isConfirmed: true,
      };
    } else {
      // User declined, delete the pending event
      await PendingEvent.findByIdAndDelete(pendingEvent._id);
      console.log(
        `User declined to add event: ${pendingEvent.eventDetails.eventName}`,
      );

      return {
        success: true,
        message: "I've discarded the event.",
        isConfirmed: false,
      };
    }
  } catch (error) {
    console.error("Error handling event confirmation:", error);
    return { success: false, message: "Error processing your response" };
  }
}

/**
 * Detect if a message is confirming or declining an event
 * @param {string} message - User's message
 * @returns {Promise<Object>} - Detection result
 */
async function detectConfirmationIntent(message) {
  // Simple pattern matching first
  const confirmPatterns = [
    /^yes$/i,
    /^yeah$/i,
    /^sure$/i,
    /^ok(ay)?$/i,
    /^confirm$/i,
    /^add it$/i,
    /^please add$/i,
    /^go ahead$/i,
  ];

  const declinePatterns = [
    /^no$/i,
    /^nope$/i,
    /^don't$/i,
    /^do not$/i,
    /^cancel$/i,
    /^discard$/i,
    /^delete$/i,
    /^ignore$/i,
    /^no thanks$/i,
  ];

  // Check for direct matches
  for (const pattern of confirmPatterns) {
    if (pattern.test(message.trim())) {
      console.log("Detected explicit confirmation in user message");
      return { isConfirming: true, confidence: 0.99 };
    }
  }

  for (const pattern of declinePatterns) {
    if (pattern.test(message.trim())) {
      console.log("Detected explicit rejection in user message");
      return { isConfirming: false, confidence: 0.99 };
    }
  }

  // For more complex messages, use Gemini
  try {
    const prompt = `
      Determine if this message is confirming or declining adding an event to a calendar.

      User message: "${message}"

      Return only a valid JSON with these fields:
      {
        "isConfirming": boolean indicating if the user is confirming/accepting,
        "confidence": number between 0 and 1 indicating confidence level
      }

      Examples:
      - "Yes please" → {"isConfirming": true, "confidence": 0.98}
      - "No thanks" → {"isConfirming": false, "confidence": 0.98}
      - "Not now" → {"isConfirming": false, "confidence": 0.95}
      - "Maybe later" → {"isConfirming": false, "confidence": 0.8}
      - "I've discarded the event" → {"isConfirming": false, "confidence": 0.9}

      If there is any ambiguity or uncertainty, lean towards NOT confirming (false).
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Default to NOT confirming if unclear
      console.log("Could not parse confirmation intent, defaulting to decline");
      return { isConfirming: false, confidence: 0.6 };
    }

    const response = JSON.parse(jsonMatch[0]);
    console.log(
      `Detected confirmation intent: ${response.isConfirming} with confidence ${response.confidence}`,
    );
    return response;
  } catch (error) {
    console.error("Error detecting confirmation intent:", error);
    // Default to NOT confirming if error
    return { isConfirming: false, confidence: 0.6 };
  }
}

/**
 * Find reminder by its position in a specific day's schedule
 * @param {string} userId - User's phone number
 * @param {number} position - Position in the day's schedule (1-based)
 * @param {string} dayName - Day name (e.g., "Thursday", "Friday") to search in
 * @returns {Promise<Document|null>} - Matching reminder or null
 */
async function findReminderByPositionInDay(userId, position, dayName) {
  try {
    console.log(`Looking for reminder at position ${position} for ${dayName}`);

    // If no valid position, return null
    if (!position || position < 1) return null;

    // Get all active reminders
    const allReminders = await Reminder.find({
      userId,
      isCompleted: false,
      status: { $ne: "completed" },
    });

    if (allReminders.length === 0) return null;

    // Group reminders by day
    const remindersByDay = {};

    allReminders.forEach((reminder) => {
      const reminderDate = moment(reminder.scheduledTime).tz(reminder.timezone);
      const day = reminderDate.format("dddd"); // e.g., "Thursday", "Friday"

      if (!remindersByDay[day]) {
        remindersByDay[day] = [];
      }

      remindersByDay[day].push(reminder);
    });

    // Sort each day's reminders by time
    for (const day in remindersByDay) {
      remindersByDay[day].sort((a, b) => {
        return moment(a.scheduledTime).diff(moment(b.scheduledTime));
      });
    }

    // If dayName is specified, look only in that day
    if (dayName) {
      // Normalize day name for case-insensitive matching
      const normalizedDayName = dayName.toLowerCase();

      // Find the matching day (case-insensitive)
      const matchingDay = Object.keys(remindersByDay).find(
        (day) => day.toLowerCase() === normalizedDayName,
      );

      if (matchingDay && remindersByDay[matchingDay].length >= position) {
        return remindersByDay[matchingDay][position - 1]; // Convert to 0-based index
      }
    } else {
      // If no day specified, look across all days
      for (const day in remindersByDay) {
        if (remindersByDay[day].length >= position) {
          return remindersByDay[day][position - 1]; // Convert to 0-based index
        }
        // Adjust position as we move through days
        position -= remindersByDay[day].length;
      }
    }

    return null;
  } catch (error) {
    console.error("Error finding reminder by position:", error);
    return null;
  }
}

/**
 * Extract day and position from delete command
 * @param {string} message - User message
 * @returns {Object} - Extracted day and position
 */
function extractDayAndPosition(message) {
  // Look for patterns like "remove 2. 9:00 AM: note in my calendar (other) from Thursday"
  const dayPatterns = [
    /(?:from|on|for)\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i,
    /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i,
  ];

  let day = null;

  // Try to extract day name
  for (const pattern of dayPatterns) {
    const match = message.match(pattern);
    if (match && match[1]) {
      day = match[1];
      break;
    }
  }

  // Look for position number
  const positionMatch = message.match(/remove\s+(\d+)[\.\:]/i);
  const position = positionMatch ? parseInt(positionMatch[1]) : null;

  return { day, position };
}

app.listen(3000, () => {
  console.log(
    "Advanced WhatsApp Chatbot with Smart Reminder System started on port 3000",
  );
});
