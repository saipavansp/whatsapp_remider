const moment = require("moment-timezone");
const { Reminder, EventDetection } = require("../../models");
const config = require("../../utils/config");

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
  timezone = config.DEFAULT_TIMEZONE,
  isRecurring = false,
  recurringPattern = null,
  category = "other",
  status = "active",
  type = "standard",
) {
  try {
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
    
    const savedReminder = await reminder.save();
    console.log(`Created reminder: ${message} for ${moment(scheduledTime).format("YYYY-MM-DD HH:mm:ss")}`);
    
    return savedReminder;
  } catch (error) {
    console.error("Error creating reminder:", error);
    throw error;
  }
}

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
  timezone = config.DEFAULT_TIMEZONE,
) {
  try {
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
  } catch (error) {
    console.error("Error creating daily briefing reminder:", error);
    throw error;
  }
}

/**
 * Create a reminder from extracted event details
 * @param {string} userId - User's phone number
 * @param {Object} eventDetails - Extracted event details
 * @returns {Promise<Document>} - Created reminder
 */
async function createEventReminder(userId, eventDetails) {
  try {
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

        scheduledTime = moment(eventDetails.eventDate).tz(config.DEFAULT_TIMEZONE);
        scheduledTime.hours(isPM && hours < 12 ? hours + 12 : hours);
        scheduledTime.minutes(minutes);
        scheduledTime.seconds(0);
      } else {
        // Default to noon if time format can't be parsed
        scheduledTime = moment(eventDetails.eventDate)
          .tz(config.DEFAULT_TIMEZONE)
          .hours(12)
          .minutes(0)
          .seconds(0);
      }
    } else {
      // For all-day events, set to 9 AM
      scheduledTime = moment(eventDetails.eventDate)
        .tz(config.DEFAULT_TIMEZONE)
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
        config.DEFAULT_TIMEZONE,
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
          config.DEFAULT_TIMEZONE,
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
  } catch (error) {
    console.error("Error creating event reminder:", error);
    throw error;
  }
}

/**
 * Update an existing reminder
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
    console.log(`Updated reminder ${reminderId}: ${JSON.stringify(updates)}`);
    
    return reminder;
  } catch (error) {
    console.error("Error updating reminder:", error);
    throw error;
  }
}

/**
 * Delete a reminder
 * @param {string} reminderId - ID of the reminder to delete
 * @returns {Promise<boolean>} - Whether deletion was successful
 */
async function deleteReminder(reminderId) {
  try {
    const reminder = await Reminder.findById(reminderId);
    if (!reminder) {
      console.log(`Reminder ${reminderId} not found for deletion`);
      return false;
    }
    
    const result = await Reminder.deleteOne({ _id: reminderId });
    console.log(`Deleted reminder ${reminderId}: ${result.deletedCount} document(s) removed`);
    
    return result.deletedCount > 0;
  } catch (error) {
    console.error(`Error deleting reminder ${reminderId}:`, error);
    throw error;
  }
}

/**
 * Pause a reminder
 * @param {string} reminderId - ID of reminder to pause
 * @returns {Promise<Document|null>} - Updated reminder
 */
async function pauseReminder(reminderId) {
  try {
    const reminder = await Reminder.findById(reminderId);
    if (!reminder) return null;

    reminder.status = "paused";
    reminder.isPaused = true;
    reminder.lastUpdated = new Date();
    await reminder.save();

    console.log(`Paused reminder: ${reminder.message}`);
    return reminder;
  } catch (error) {
    console.error("Error pausing reminder:", error);
    throw error;
  }
}

/**
 * Resume a paused reminder
 * @param {string} reminderId - ID of reminder to resume
 * @returns {Promise<Document|null>} - Updated reminder
 */
async function resumeReminder(reminderId) {
  try {
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

    console.log(`Resumed reminder: ${reminder.message}`);
    return reminder;
  } catch (error) {
    console.error("Error resuming reminder:", error);
    throw error;
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
 * Clean up old completed reminders (older than specified days)
 * @param {number} daysToKeep - Number of days to keep completed reminders (default 7)
 * @returns {Promise<number>} - Number of deleted reminders
 */
async function cleanupOldReminders(daysToKeep = 7) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  try {
    const result = await Reminder.deleteMany({
      isCompleted: true,
      scheduledTime: { $lt: cutoffDate },
    });
    console.log(`Cleaned up ${result.deletedCount} old reminders`);
    return result.deletedCount;
  } catch (error) {
    console.error("Error cleaning up old reminders:", error);
    throw error;
  }
}

module.exports = {
  createReminder,
  createDailyBriefingReminder,
  createEventReminder,
  updateReminder,
  deleteReminder,
  pauseReminder,
  resumeReminder,
  calculateNextOccurrence,
  cleanupOldReminders
}; 