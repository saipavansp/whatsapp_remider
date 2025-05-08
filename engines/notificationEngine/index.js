const schedule = require("node-schedule");
const moment = require("moment-timezone");
const { Reminder } = require("../../models");
const config = require("../../utils/config");
const messageUtils = require("../../utils/messageUtils");
const reminderEngine = require("../reminderEngine");

// Global map to track all scheduled jobs
const scheduledJobs = {};

/**
 * Initialize the notification engine
 * Loads all pending reminders and schedules them
 */
async function initialize() {
  try {
    console.log("Initializing notification engine...");
    
    // Cancel any existing jobs
    Object.values(scheduledJobs).forEach(job => job.cancel());
    
    // Load all pending reminders
    const pendingReminders = await Reminder.find({
      isCompleted: false,
      status: { $ne: "completed" },
      isPaused: { $ne: true }
    });

    console.log(`Found ${pendingReminders.length} pending reminders to schedule`);

    // Schedule each reminder
    for (const reminder of pendingReminders) {
      await scheduleReminderJob(reminder);
    }
    
    console.log("Notification engine initialized successfully");
  } catch (error) {
    console.error("Error initializing notification engine:", error);
    throw error;
  }
}

/**
 * Schedule a specific job for a reminder
 * @param {Document} reminder - The reminder document to schedule
 * @returns {Promise<void>}
 */
async function scheduleReminderJob(reminder) {
  try {
    // Don't schedule paused reminders
    if (reminder.isPaused || reminder.status === "paused") {
      console.log(`Skipping scheduling paused reminder: ${reminder.message}`);
      return;
    }

    // Skip reminders that are already in the past without proper handling
    const scheduledTime = moment(reminder.scheduledTime).toDate();
    const now = new Date();
    if (scheduledTime < now) {
      console.log(`Reminder ${reminder._id} is in the past, rescheduling appropriately`);
      
      // For recurring reminders, calculate next occurrence from now
      if (reminder.isRecurring) {
        const nextTime = reminderEngine.calculateNextOccurrence(
          now,
          reminder.recurringPattern,
          reminder.timezone
        );
        
        if (nextTime) {
          // Update the reminder with the new time
          reminder.scheduledTime = nextTime;
          await reminder.save();
          console.log(`Rescheduled recurring reminder to ${moment(nextTime).format("YYYY-MM-DD HH:mm:ss")}`);
        } else {
          console.log(`Could not calculate next occurrence for reminder ${reminder._id}`);
          return;
        }
      } else {
        // For non-recurring reminders in the past, mark as missed
        console.log(`Non-recurring reminder ${reminder._id} has passed and will be marked as missed`);
        reminder.status = "completed";
        reminder.isCompleted = true;
        await reminder.save();
        return;
      }
    }

    const jobName = `reminder_${reminder._id}`;

    // Cancel any existing job with this ID
    if (scheduledJobs[jobName]) {
      scheduledJobs[jobName].cancel();
      delete scheduledJobs[jobName];
    }

    // Schedule one-time job for this specific reminder
    scheduledJobs[jobName] = schedule.scheduleJob(jobName, scheduledTime, async function () {
      console.log(`Executing scheduled reminder: ${reminder.message} (Type: ${reminder.type})`);

      try {
        // Get the latest reminder state from the database
        const currentReminder = await Reminder.findById(reminder._id);
        
        // Only proceed if the reminder is still active
        if (!currentReminder || currentReminder.isCompleted || currentReminder.isPaused) {
          console.log(`Reminder ${reminder._id} is no longer active, skipping notification`);
          return;
        }

        // Handle different types of reminders
        if (currentReminder.type === "daily_briefing") {
          // Handle daily briefing type
          await handleDailyBriefing(currentReminder);
        } else {
          // Handle standard reminder type - with retry logic
          const result = await messageUtils.sendMessageWithRetry(
            currentReminder.userId,
            `⏰ REMINDER: ${currentReminder.message}`
          );
          
          if (!result) {
            console.error(`Failed to send reminder ${currentReminder._id} after multiple attempts`);
            // TODO: Could add additional error handling, notification to admin, etc.
          }

          // Handle recurring reminders
          if (currentReminder.isRecurring) {
            // Calculate next occurrence and create a new reminder
            const nextTime = reminderEngine.calculateNextOccurrence(
              currentReminder.scheduledTime,
              currentReminder.recurringPattern,
              currentReminder.timezone,
            );

            if (nextTime) {
              const newReminder = await reminderEngine.createReminder(
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
              await scheduleReminderJob(newReminder);
            }
          }

          // Mark current one as completed
          currentReminder.isCompleted = true;
          currentReminder.status = "completed";
          await currentReminder.save();

          console.log(`Sent reminder to ${currentReminder.userId}: ${currentReminder.message}`);
        }
      } catch (error) {
        console.error(`Error processing reminder ${reminder._id}:`, error);
      }
    });

    console.log(
      `Scheduled ${reminder.type} reminder "${reminder.message}" for ${moment(scheduledTime).format("YYYY-MM-DD HH:mm:ss")}`
    );
  } catch (error) {
    console.error(`Error scheduling reminder job for ${reminder._id}:`, error);
  }
}

/**
 * Handle daily briefing reminders
 * @param {Document} reminderDoc - The daily briefing reminder document
 * @returns {Promise<void>}
 */
async function handleDailyBriefing(reminderDoc) {
  try {
    const briefingMessage = await generateDailyBriefing(
      reminderDoc.userId,
      reminderDoc.timezone,
    );

    // Send the briefing to the user with retry logic
    await messageUtils.sendMessageWithRetry(reminderDoc.userId, briefingMessage);

    console.log(`Sent daily briefing to ${reminderDoc.userId}`);

    // If it's a recurring daily briefing, schedule the next one
    if (reminderDoc.isRecurring) {
      // Calculate next occurrence
      const nextTime = reminderEngine.calculateNextOccurrence(
        reminderDoc.scheduledTime,
        reminderDoc.recurringPattern,
        reminderDoc.timezone,
      );

      if (nextTime) {
        const newReminder = await reminderEngine.createReminder(
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
        await scheduleReminderJob(newReminder);
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
 * Generate a daily briefing message
 * @param {string} userId - User's phone number
 * @param {string} timezone - User's timezone
 * @returns {Promise<string>} - Briefing message
 */
async function generateDailyBriefing(userId, timezone = config.DEFAULT_TIMEZONE) {
  try {
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
  } catch (error) {
    console.error("Error generating daily briefing:", error);
    return "I was unable to generate your daily briefing due to an error. Please try again later.";
  }
}

/**
 * Get reminders for a specific day
 * @param {string} userId - User's phone number
 * @param {Date} date - The date to query
 * @param {string} timezone - User's timezone
 * @returns {Promise<Array>} - Array of reminders
 */
async function getRemindersForDay(userId, date, timezone = config.DEFAULT_TIMEZONE) {
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
 * Add a new reminder and schedule it for notification
 * @param {Document} reminder - The reminder document
 * @returns {Promise<void>}
 */
async function addReminder(reminder) {
  await scheduleReminderJob(reminder);
}

/**
 * Cancel a scheduled reminder notification
 * @param {string} reminderId - The ID of the reminder to cancel
 * @returns {boolean} - Whether the job was cancelled
 */
function cancelReminder(reminderId) {
  const jobName = `reminder_${reminderId}`;
  const existingJob = scheduledJobs[jobName];
  
  if (existingJob) {
    existingJob.cancel();
    delete scheduledJobs[jobName];
    console.log(`Cancelled scheduled job for reminder: ${reminderId}`);
    return true;
  }
  
  return false;
}

/**
 * Recompute scheduling for a single reminder
 * @param {string} reminderId - ID of the reminder
 * @returns {Promise<boolean>} - Whether rescheduling was successful
 */
async function rescheduleReminder(reminderId) {
  try {
    // Get the latest version of the reminder
    const reminder = await Reminder.findById(reminderId);
    if (!reminder) {
      console.log(`Reminder ${reminderId} not found for rescheduling`);
      return false;
    }
    
    // Cancel existing job if any
    cancelReminder(reminderId);
    
    // Schedule new job if reminder is active
    if (!reminder.isCompleted && reminder.status !== "completed" && !reminder.isPaused) {
      await scheduleReminderJob(reminder);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`Error rescheduling reminder ${reminderId}:`, error);
    return false;
  }
}

module.exports = {
  initialize,
  scheduleReminderJob,
  handleDailyBriefing,
  generateDailyBriefing,
  getRemindersForDay,
  addReminder,
  cancelReminder,
  rescheduleReminder
}; 