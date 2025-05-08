const moment = require("moment-timezone");
const { Reminder } = require("../../models");
const config = require("../../utils/config");

/**
 * Get all active reminders for a user
 * @param {string} userId - The user's ID
 * @returns {Promise<Array>} - List of active reminders
 */
async function getAllReminders(userId) {
  try {
    const reminders = await Reminder.find({
      userId,
      isCompleted: false,
      status: { $ne: "completed" },
      type: "standard",
    }).sort({ scheduledTime: 1 });
    
    return reminders;
  } catch (error) {
    console.error("Error getting all reminders:", error);
    throw error;
  }
}

/**
 * Format reminders list as a readable message
 * @param {Array} reminders - List of reminder documents
 * @param {string} title - Title for the message
 * @returns {string} - Formatted message
 */
function formatRemindersList(reminders, title = "Your reminders") {
  if (reminders.length === 0) {
    return "You have no active reminders.";
  }
  
  const formattedList = reminders.map((r, i) => {
    const time = moment(r.scheduledTime)
      .tz(r.timezone)
      .format("ddd, MMM D, YYYY [at] h:mm A z");
    const statusIndicator = r.status === "paused" ? " [PAUSED]" : "";
    return `${i + 1}. "${r.message}" - ${time}${r.isRecurring ? ` (recurring ${r.recurringPattern})` : ""}${statusIndicator} (${r.category})`;
  }).join("\n\n");
  
  return `📋 ${title}:\n\n${formattedList}`;
}

/**
 * Get reminders for a specific day
 * @param {string} userId - User's phone number
 * @param {Date} date - The date to query
 * @param {string} timezone - User's timezone
 * @returns {Promise<Array>} - Array of reminders
 */
async function getRemindersForDay(userId, date, timezone = config.DEFAULT_TIMEZONE) {
  try {
    const startOfDay = moment(date).tz(timezone).startOf("day").toDate();
    const endOfDay = moment(date).tz(timezone).endOf("day").toDate();

    return await Reminder.find({
      userId,
      scheduledTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $ne: "completed" },
      type: "standard", // Exclude meta-reminders
    }).sort({ scheduledTime: 1 });
  } catch (error) {
    console.error("Error getting reminders for day:", error);
    throw error;
  }
}

/**
 * Format daily reminders as a readable message
 * @param {Array} reminders - List of reminder documents
 * @param {string} dateString - Formatted date string
 * @returns {string} - Formatted message
 */
function formatDailyReminders(reminders, dateString) {
  if (reminders.length === 0) {
    return `You have no reminders scheduled for ${dateString}.`;
  }
  
  const formattedList = reminders.map((r, i) => {
    const time = moment(r.scheduledTime)
      .tz(r.timezone)
      .format("h:mm A");
    return `${i + 1}. ${time}: ${r.message} (${r.category})`;
  }).join("\n\n");
  
  return `📆 Your schedule for ${dateString}:\n\n${formattedList}`;
}

/**
 * Get today's reminders
 * @param {string} userId - User's ID
 * @param {string} timezone - User's timezone
 * @returns {Promise<{reminders: Array, message: string}>} - Reminders and formatted message
 */
async function getTodayReminders(userId, timezone = config.DEFAULT_TIMEZONE) {
  try {
    const today = moment().tz(timezone).toDate();
    const reminders = await getRemindersForDay(userId, today, timezone);
    const dateString = moment(today).format("dddd, MMMM D");
    const message = formatDailyReminders(reminders, dateString);
    
    return { reminders, message };
  } catch (error) {
    console.error("Error getting today's reminders:", error);
    throw error;
  }
}

/**
 * Get tomorrow's reminders
 * @param {string} userId - User's ID
 * @param {string} timezone - User's timezone
 * @returns {Promise<{reminders: Array, message: string}>} - Reminders and formatted message
 */
async function getTomorrowReminders(userId, timezone = config.DEFAULT_TIMEZONE) {
  try {
    const tomorrow = moment().tz(timezone).add(1, "day").toDate();
    const reminders = await getRemindersForDay(userId, tomorrow, timezone);
    const dateString = moment(tomorrow).format("dddd, MMMM D");
    const message = formatDailyReminders(reminders, dateString);
    
    return { reminders, message };
  } catch (error) {
    console.error("Error getting tomorrow's reminders:", error);
    throw error;
  }
}

/**
 * Get reminders for the current week
 * @param {string} userId - User's ID
 * @param {string} timezone - User's timezone
 * @returns {Promise<{reminders: Array, message: string}>} - Reminders and formatted message
 */
async function getWeekReminders(userId, timezone = config.DEFAULT_TIMEZONE) {
  try {
    const startOfWeek = moment().tz(timezone).startOf("week").toDate();
    const endOfWeek = moment().tz(timezone).endOf("week").toDate();
    
    const reminders = await Reminder.find({
      userId,
      scheduledTime: { $gte: startOfWeek, $lte: endOfWeek },
      status: { $ne: "completed" },
      type: "standard",
    }).sort({ scheduledTime: 1 });
    
    if (reminders.length === 0) {
      return {
        reminders: [],
        message: "You have no reminders scheduled for this week."
      };
    }
    
    // Group reminders by day
    const remindersByDay = {};
    reminders.forEach(reminder => {
      const day = moment(reminder.scheduledTime)
        .tz(reminder.timezone)
        .format("dddd, MMMM D");
        
      if (!remindersByDay[day]) {
        remindersByDay[day] = [];
      }
      remindersByDay[day].push(reminder);
    });
    
    // Format the response
    let message = "📅 Your schedule for this week:\n\n";
    
    for (const day in remindersByDay) {
      message += `*${day}*\n`;
      remindersByDay[day].forEach((reminder, i) => {
        const time = moment(reminder.scheduledTime)
          .tz(reminder.timezone)
          .format("h:mm A");
        message += `${i + 1}. ${time}: ${reminder.message} (${reminder.category})\n`;
      });
      message += "\n";
    }
    
    return { reminders, message };
  } catch (error) {
    console.error("Error getting week reminders:", error);
    throw error;
  }
}

/**
 * Get reminders for the current month
 * @param {string} userId - User's ID
 * @param {string} timezone - User's timezone
 * @returns {Promise<{reminders: Array, message: string}>} - Reminders and formatted message
 */
async function getMonthReminders(userId, timezone = config.DEFAULT_TIMEZONE) {
  try {
    const startOfMonth = moment().tz(timezone).startOf("month").toDate();
    const endOfMonth = moment().tz(timezone).endOf("month").toDate();
    
    const reminders = await Reminder.find({
      userId,
      scheduledTime: { $gte: startOfMonth, $lte: endOfMonth },
      status: { $ne: "completed" },
      type: "standard",
    }).sort({ scheduledTime: 1 });
    
    if (reminders.length === 0) {
      return {
        reminders: [],
        message: "You have no reminders scheduled for this month."
      };
    }
    
    // Group reminders by day
    const remindersByDay = {};
    reminders.forEach(reminder => {
      const day = moment(reminder.scheduledTime)
        .tz(reminder.timezone)
        .format("dddd, MMMM D");
        
      if (!remindersByDay[day]) {
        remindersByDay[day] = [];
      }
      remindersByDay[day].push(reminder);
    });
    
    // Format the response
    let message = `📅 Your schedule for ${moment().format("MMMM YYYY")}:\n\n`;
    
    for (const day in remindersByDay) {
      message += `*${day}*\n`;
      remindersByDay[day].forEach((reminder, i) => {
        const time = moment(reminder.scheduledTime)
          .tz(reminder.timezone)
          .format("h:mm A");
        message += `${i + 1}. ${time}: ${reminder.message} (${reminder.category})\n`;
      });
      message += "\n";
    }
    
    return { reminders, message };
  } catch (error) {
    console.error("Error getting month reminders:", error);
    throw error;
  }
}

/**
 * Get reminders by category
 * @param {string} userId - User's ID
 * @param {string} category - Category to filter by
 * @returns {Promise<{reminders: Array, message: string}>} - Reminders and formatted message
 */
async function getRemindersByCategory(userId, category) {
  try {
    const reminders = await Reminder.find({
      userId,
      category,
      status: { $ne: "completed" },
      type: "standard",
    }).sort({ scheduledTime: 1 });
    
    if (reminders.length === 0) {
      return {
        reminders: [],
        message: `You have no active reminders in the "${category}" category.`
      };
    }
    
    const formattedList = reminders.map((r, i) => {
      const time = moment(r.scheduledTime)
        .tz(r.timezone)
        .format("ddd, MMM D, YYYY [at] h:mm A");
      return `${i + 1}. ${time}: ${r.message}${r.isRecurring ? ` (recurring ${r.recurringPattern})` : ""}`;
    }).join("\n\n");
    
    return {
      reminders,
      message: `📋 Your ${category} reminders:\n\n${formattedList}`
    };
  } catch (error) {
    console.error("Error getting reminders by category:", error);
    throw error;
  }
}

/**
 * Get upcoming reminders
 * @param {string} userId - User's ID
 * @param {number} limit - Maximum number of reminders to fetch
 * @returns {Promise<{reminders: Array, message: string}>} - Reminders and formatted message
 */
async function getUpcomingReminders(userId, limit = 10) {
  try {
    const now = moment().toDate();
    const future = moment().add(30, "days").toDate(); // Look 30 days ahead
    
    const reminders = await Reminder.find({
      userId,
      scheduledTime: { $gte: now },
      status: { $ne: "completed" },
      type: "standard",
    })
      .sort({ scheduledTime: 1 })
      .limit(limit);
    
    if (reminders.length === 0) {
      return {
        reminders: [],
        message: "You have no upcoming reminders scheduled."
      };
    }
    
    // Group reminders by day
    const remindersByDay = {};
    reminders.forEach(reminder => {
      const day = moment(reminder.scheduledTime)
        .tz(reminder.timezone)
        .format("dddd, MMMM D");
        
      if (!remindersByDay[day]) {
        remindersByDay[day] = [];
      }
      remindersByDay[day].push(reminder);
    });
    
    // Format the response
    let message = "📅 Your upcoming schedule:\n\n";
    
    for (const day in remindersByDay) {
      message += `*${day}*\n`;
      remindersByDay[day].forEach((reminder, i) => {
        const time = moment(reminder.scheduledTime)
          .tz(reminder.timezone)
          .format("h:mm A");
        message += `${i + 1}. ${time}: ${reminder.message} (${reminder.category})\n`;
      });
      message += "\n";
    }
    
    return { reminders, message };
  } catch (error) {
    console.error("Error getting upcoming reminders:", error);
    throw error;
  }
}

/**
 * Get the user's most recent reminder
 * @param {string} userId - User's ID
 * @returns {Promise<{reminder: Object|null, message: string}>} - Reminder and formatted message
 */
async function getLastReminder(userId) {
  try {
    const reminder = await Reminder.findOne({
      userId,
      status: { $ne: "completed" },
      type: "standard",
    }).sort({ createdAt: -1 }); // Sort by creation time, most recent first
    
    if (!reminder) {
      return {
        reminder: null,
        message: "You have no active reminders."
      };
    }
    
    const time = moment(reminder.scheduledTime)
      .tz(reminder.timezone)
      .format("ddd, MMM D, YYYY [at] h:mm A z");
    const recurringInfo = reminder.isRecurring ? ` (recurring ${reminder.recurringPattern})` : "";
    const statusInfo = reminder.status === "paused" ? " [PAUSED]" : "";
    
    return {
      reminder,
      message: `Your most recent reminder is:\n\n"${reminder.message}" scheduled for ${time}${recurringInfo}${statusInfo} (Category: ${reminder.category})`
    };
  } catch (error) {
    console.error("Error getting last reminder:", error);
    throw error;
  }
}

/**
 * Find a reminder by exact ID
 * @param {string} reminderId - The reminder ID
 * @returns {Promise<Object|null>} - The reminder document or null
 */
async function getReminderById(reminderId) {
  try {
    return await Reminder.findById(reminderId);
  } catch (error) {
    console.error("Error getting reminder by ID:", error);
    throw error;
  }
}

/**
 * Find a reminder by position in a specific day's schedule
 * @param {string} userId - User's phone number
 * @param {number} position - Position in the day's schedule (1-based)
 * @param {string} dayName - Day name (e.g., "Thursday", "Friday") to search in
 * @returns {Promise<Document|null>} - Matching reminder or null
 */
async function findReminderByPositionInDay(userId, position, dayName) {
  try {
    console.log(`Looking for reminder at position ${position} for ${dayName || "any day"}`);

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
    throw error;
  }
}

/**
 * Extract day and position from a message
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

  // Look for position number with different patterns
  const positionMatch = message.match(/(\d+)[\.\:]|number (\d+)|reminder (\d+)/i);
  const position = positionMatch ? 
    parseInt(positionMatch[1] || positionMatch[2] || positionMatch[3]) : null;

  return { day, position };
}

/**
 * Identify which reminder a user is referring to in a message
 * @param {string} userId - User's ID
 * @param {string} message - User's message
 * @returns {Promise<Object|null>} - The identified reminder or null
 */
async function identifyReminderFromMessage(userId, message) {
  try {
    // First check for day and position pattern
    const dayPositionInfo = extractDayAndPosition(message);
    if (dayPositionInfo.position) {
      console.log(`Extracted position ${dayPositionInfo.position} and day ${dayPositionInfo.day || "any"} from message`);
      
      const reminderByPosition = await findReminderByPositionInDay(
        userId,
        dayPositionInfo.position,
        dayPositionInfo.day,
      );

      if (reminderByPosition) {
        console.log(`Found reminder by position: "${reminderByPosition.message}"`);
        return reminderByPosition;
      }
    }
    
    // If only one reminder exists, return it
    const allReminders = await getAllReminders(userId);
    if (allReminders.length === 1) {
      return allReminders[0];
    }
    
    // Try to match based on text content
    const lowerMessage = message.toLowerCase();
    
    // Look for reminder that contains text from the message
    for (const reminder of allReminders) {
      const reminderText = reminder.message.toLowerCase();
      if (lowerMessage.includes(reminderText) || 
          (reminderText.length > 5 && textSimilarity(lowerMessage, reminderText) > 0.7)) {
        console.log(`Found reminder by content similarity: "${reminder.message}"`);
        return reminder;
      }
    }
    
    return null;
  } catch (error) {
    console.error("Error identifying reminder from message:", error);
    throw error;
  }
}

/**
 * Calculate simple text similarity between two strings
 * @param {string} text1 - First string
 * @param {string} text2 - Second string
 * @returns {number} - Similarity score between 0 and 1
 */
function textSimilarity(text1, text2) {
  const shorter = text1.length < text2.length ? text1 : text2;
  const longer = text1.length < text2.length ? text2 : text1;
  
  // Check if shorter is a substring of longer
  if (longer.includes(shorter)) {
    return shorter.length / longer.length;
  }
  
  // Count common words
  const words1 = text1.split(/\s+/);
  const words2 = text2.split(/\s+/);
  
  const commonWords = words1.filter(word => 
    words2.includes(word) && word.length > 2 // Only count words longer than 2 chars
  );
  
  if (commonWords.length === 0) {
    return 0;
  }
  
  return commonWords.length / Math.max(words1.length, words2.length);
}

module.exports = {
  getAllReminders,
  formatRemindersList,
  getRemindersForDay,
  formatDailyReminders,
  getTodayReminders,
  getTomorrowReminders,
  getWeekReminders,
  getMonthReminders,
  getRemindersByCategory,
  getUpcomingReminders,
  getLastReminder,
  getReminderById,
  findReminderByPositionInDay,
  extractDayAndPosition,
  identifyReminderFromMessage
}; 