const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("./config");
const moment = require("moment-timezone");

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

/**
 * Detect the user's intent from their message
 * @param {string} text - User message
 * @returns {Promise<Object>} - Intent and confidence score
 */
async function detectUserIntent(text) {
  try {
    // Quick check for date-specific patterns before using the LLM
    const datePatterns = [
      // Month followed by day number (with optional ordinal)
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)[\s,]+\d{1,2}(st|nd|rd|th)?\b/i,
      // Day number (with optional ordinal) followed by month
      /\b\d{1,2}(st|nd|rd|th)?[\s,]+(of[\s,]+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
      // Specific days of week with "next" or "this"
      /\b(next|this)[\s,]+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      // Dates like MM/DD or MM-DD
      /\b(0?[1-9]|1[0-2])[\/-](0?[1-9]|[12][0-9]|3[01])\b/,
      // Checking for "on" or "for" followed by date expressions
      /\bon[\s,]+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\bfor[\s,]+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
    ];

    // Check if the message matches any date patterns AND contains query words
    const containsDatePattern = datePatterns.some(pattern => pattern.test(text));
    const containsQueryWords = /\b(what|show|list|any|have|tell|events|schedules|reminders|plans|appointments)\b/i.test(text);

    // If this clearly looks like a date-specific query, we can shortcut to query_specific_date
    if (containsDatePattern && containsQueryWords && 
        !text.toLowerCase().includes("today") && 
        !text.toLowerCase().includes("tomorrow")) {

      console.log("Date pattern detected, classifying as query_specific_date without LLM");

      return {
        intent: "query_specific_date",
        confidence: 0.95,
        category: null,
        explanation: "Direct detection of date pattern in query"
      };
    }

    // For other cases, continue with LLM-based intent detection
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
      - delete_date_reminders: User wants to DELETE ALL reminders for a specific date
      - delete_all_reminders: User wants to DELETE ALL reminders without date limitation
      - pause_reminder: User wants to TEMPORARILY PAUSE a recurring reminder
      - resume_reminder: User wants to RESUME a previously paused reminder
      - daily_briefing: User wants to receive a daily summary of their schedule
      - query_today: User is ASKING ABOUT today's events, schedule or activities
      - query_tomorrow: User is specifically ASKING ABOUT tomorrow's events/schedule
      - query_specific_date: User is ASKING ABOUT events for a SPECIFIC DATE (not today/tomorrow)
      - query_week: User is ASKING ABOUT events for this week
      - query_month: User is ASKING ABOUT events for this month
      - query_category: User is ASKING ABOUT reminders of a specific category
      - query_recurring: User is ASKING ABOUT only their recurring reminders
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
      6. For delete_date_reminders, user must specify a specific date to delete (e.g., "Delete all reminders for Friday")
      7. For delete_all_reminders, user is asking to delete ALL reminders without date specification (e.g., "Delete all my reminders")
      8. For query_recurring, user is specifically asking about recurring/repeating reminders (e.g., "Show my recurring reminders")
      9. For query_specific_date, user is asking about events on a specific date that is not today or tomorrow (e.g., "What events do I have on May 29th?", "Show me events for June 15")

      EXAMPLES OF QUERY INTENTS (not creating anything):
      - "What do I have today?" => query_today
      - "What are my events for today?" => query_today
      - "Show me today's schedule" => query_today
      - "What's happening today?" => query_today
      - "What events do I have today?" => query_today
      - "Do I have anything today?" => query_today
      - "What all the events today?" => query_today
      - "What all the events I have today?" => query_today
      - "Show me my recurring reminders" => query_recurring
      - "What are my daily reminders?" => query_recurring
      - "List all my repeating events" => query_recurring
      - "What events do I have on May 29th?" => query_specific_date
      - "Show me reminders for June 15" => query_specific_date
      - "What are events on May 29" => query_specific_date
      - "Anything scheduled for next Monday?" => query_specific_date

      EXAMPLES OF ACTION INTENTS (modifying data):
      - "Add a new event called meeting at 3pm" => set_reminder
      - "Create a reminder for my doctor's appointment" => set_reminder
      - "Delete all reminders for Friday" => delete_date_reminders
      - "Remove all events for tomorrow" => delete_date_reminders
      - "Clear all my reminders" => delete_all_reminders
      - "Delete everything" => delete_all_reminders
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
 * Extract reminder details from natural language text
 * @param {string} text - User message containing reminder request
 * @returns {Promise<Object>} - Extracted reminder details
 */
async function extractReminderDetails(text) {
  try {
    // First, verify this is actually a reminder creation request
    const isActuallyReminder = await validateReminderRequest(text);
    if (!isActuallyReminder.isReminder) {
      console.log(`Text rejected as reminder: ${isActuallyReminder.reason}`);
      return null;
    }

    // Get current date in a clear, unambiguous format
    const now = moment().tz(config.DEFAULT_TIMEZONE);
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
      parsedResult.timezone = config.DEFAULT_TIMEZONE;
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
      `Parsed reminder time: ${reminderTime.format("YYYY-MM-DD HH:mm:ss Z")}`
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
 * Process message using Gemini AI with conversation context
 * @param {Document} conversation - The conversation document
 * @param {string} mediaType - Type of media (text, image, document)
 * @param {string} mediaUrl - URL to the media file (if any)
 * @returns {Promise<string>} - AI's response
 */
async function processMessageWithAI(conversation, mediaType, mediaUrl) {
  try {
    // Get the most recent conversation history (last 10 messages)
    const recentMessages = conversation.messages.slice(-10).map((msg) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    }));

    // Initialize Gemini model based on input type
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    // Create a chat session
    const chat = model.startChat({
      history: recentMessages,
      generationConfig: {
        maxOutputTokens: 1000,
      },
    });

    // Get the user's last message
    const userMessage = conversation.messages[conversation.messages.length - 1].content;

    // Send message and get response
    const result = await chat.sendMessage(userMessage);
    return result.response.text();
  } catch (error) {
    console.error("Error processing with AI:", error);
    return "I'm sorry, I encountered an error while processing your message. Please try again later.";
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
    const now = moment().tz(config.DEFAULT_TIMEZONE);
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
      - Time zone: ${config.DEFAULT_TIMEZONE}

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
 * Extract date information from a user message
 * @param {string} text - User message
 * @returns {Promise<Object>} - Extracted date, confidence, and explanation
 */
async function extractDateFromMessage(text) {
  try {
    const now = moment().tz(config.DEFAULT_TIMEZONE);
    const currentDate = now.format("YYYY-MM-DD");
    const formattedNow = now.format("dddd, MMMM D, YYYY");

    const prompt = `
      You are an AI assistant extracting date information from user messages.

      Given this message: "${text}"

      Extract the specific date mentioned. It could be:
      - An absolute date ("May 5th", "June 3", "2023-04-12")
      - A relative date ("today", "tomorrow", "next Monday")
      - A day of week ("Monday", "Tuesday", "this Friday")

      Today's date is ${currentDate} (${formattedNow})

      Return ONLY a valid JSON with these fields:
      {
        "extractedDate": the date in YYYY-MM-DD format,
        "confidence": a number between 0 and 1 indicating your confidence,
        "explanation": brief explanation of how you determined this date
      }

      If no specific date is mentioned, return null for the date with explanation.
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Parse the JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { extractedDate: null, confidence: 0, explanation: "Failed to extract date information" };
    }

    const parsedResult = JSON.parse(jsonMatch[0]);

    // If we have a date, return it as a Date object
    if (parsedResult.extractedDate) {
      return {
        extractedDate: new Date(parsedResult.extractedDate),
        confidence: parsedResult.confidence,
        explanation: parsedResult.explanation
      };
    }

    return parsedResult;
  } catch (error) {
    console.error("Error extracting date from message:", error);
    return { extractedDate: null, confidence: 0, explanation: "Error in date extraction process" };
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
    const now = moment().tz(config.DEFAULT_TIMEZONE);
    const currentYear = now.year();
    const fs = require('fs');
    const path = require('path');
    const { promisify } = require('util');
    const readFileAsync = promisify(fs.readFile);

    // Read the file
    const filePath = path.join(process.cwd(), mediaUrl);
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
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-pro-vision" });
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

module.exports = {
  detectUserIntent,
  validateReminderRequest,
  extractReminderDetails,
  processMessageWithAI,
  checkIfTextContainsEvent,
  extractEventFromText,
  extractDateFromMessage,
  extractEventFromMedia
};