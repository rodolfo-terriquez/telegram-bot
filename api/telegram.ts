import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TelegramUpdate, Intent } from "../lib/types.js";
import * as telegram from "../lib/telegram.js";
import { transcribeAudio } from "../lib/whisper.js";
import { parseIntent, calculateNextNagDelay } from "../lib/claude.js";
import * as redis from "../lib/redis.js";
import {
  scheduleReminder,
  scheduleDailyCheckin,
  scheduleWeeklySummary,
  scheduleDailySummary,
  deleteSchedule,
  cancelScheduledMessage,
} from "../lib/qstash.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Only accept POST requests
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const update = req.body as TelegramUpdate;

    // Ignore updates without messages
    if (!update.message) {
      res.status(200).json({ ok: true });
      return;
    }

    const { message } = update;
    const chatId = message.chat.id;

    // Check if user is allowed (if ALLOWED_USERS is set)
    const allowedUsers = process.env.ALLOWED_USERS;
    if (allowedUsers) {
      const allowed = allowedUsers.split(",").map((u) => u.trim().toLowerCase());
      const userId = message.from?.id?.toString();
      const username = message.from?.username?.toLowerCase();

      const isAllowed =
        (userId && allowed.includes(userId)) || (username && allowed.includes(username));

      if (!isAllowed) {
        console.log(`Unauthorized user: ${username} (${userId})`);
        await telegram.sendMessage(
          chatId,
          "Sorry, this bot is private. Contact the owner for access.",
        );
        res.status(200).json({ ok: true });
        return;
      }
    }

    // Register this chat and set up default schedules for new users
    const isNewUser = await redis.registerChat(chatId);
    if (isNewUser) {
      await setupDefaultSchedules(chatId);
    }

    let userText: string;

    // Handle voice messages
    if (message.voice) {
      await telegram.sendMessage(chatId, "🎤 Transcribing your voice message...");

      try {
        const filePath = await telegram.getFilePath(message.voice.file_id);
        const audioBuffer = await telegram.downloadFile(filePath);
        userText = await transcribeAudio(audioBuffer);

        // Show transcription to user
        await telegram.sendMessage(chatId, `📝 _"${userText}"_`);
      } catch (error) {
        console.error("Transcription error:", error);
        await telegram.sendMessage(
          chatId,
          "Sorry, I couldn't transcribe that voice message. Please try again or send a text message.",
        );
        res.status(200).json({ ok: true });
        return;
      }
    } else if (message.text) {
      userText = message.text;
    } else {
      // Ignore other message types
      res.status(200).json({ ok: true });
      return;
    }

    // Get conversation history and check-in state for context
    const [conversationHistory, isAwaitingCheckin] = await Promise.all([
      redis.getConversationHistory(chatId),
      redis.isAwaitingCheckin(chatId),
    ]);

    // Parse intent using Claude (with conversation context)
    const intent = await parseIntent(userText, conversationHistory, isAwaitingCheckin);

    // Handle the intent
    const response = await handleIntent(chatId, intent);

    // Save to conversation history
    if (response) {
      await redis.addToConversation(chatId, userText, response);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

async function handleIntent(chatId: number, intent: Intent): Promise<string | null> {
  switch (intent.type) {
    case "reminder":
      return await handleReminder(chatId, intent);

    case "brain_dump":
      return await handleBrainDump(chatId, intent);

    case "mark_done":
      return await handleMarkDone(chatId, intent);

    case "cancel_task":
      return await handleCancelTask(chatId, intent);

    case "list_tasks":
      return await handleListTasks(chatId);

    case "conversation":
      await telegram.sendMessage(chatId, intent.response);
      return intent.response;

    case "checkin_response":
      return await handleCheckinResponse(chatId, intent);

    case "set_checkin_time":
      return await handleSetCheckinTime(chatId, intent);
  }
}

async function handleReminder(
  chatId: number,
  intent: { type: "reminder"; task: string; delayMinutes: number; isImportant: boolean },
): Promise<string> {
  // Create the task in Redis
  const task = await redis.createTask(chatId, intent.task, intent.isImportant, intent.delayMinutes);

  // Schedule the reminder via QStash
  try {
    console.log(`Scheduling reminder for task ${task.id} in ${intent.delayMinutes} minutes`);
    const messageId = await scheduleReminder(chatId, task.id, intent.delayMinutes, false);
    console.log(`QStash message scheduled: ${messageId}`);

    // Store the QStash message ID for potential cancellation
    task.qstashMessageId = messageId;
    await redis.updateTask(task);
  } catch (error) {
    console.error("Failed to schedule QStash reminder:", error);
    // Still continue - task is saved, just won't get a push notification
  }

  // Format time for user
  const timeStr = formatDelay(intent.delayMinutes);
  const importantStr = intent.isImportant ? " (I'll nag you until it's done!)" : "";

  const response = `✅ Got it! I'll remind you to *${intent.task}* in ${timeStr}${importantStr}`;
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleBrainDump(
  chatId: number,
  intent: { type: "brain_dump"; content: string },
): Promise<string> {
  await redis.createBrainDump(chatId, intent.content);

  const response = `💭 Captured! I've saved that thought. You'll see it in your daily summary.`;
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleMarkDone(
  chatId: number,
  intent: { type: "mark_done"; taskDescription?: string },
): Promise<string> {
  // Find the task
  const task = await redis.findTaskByDescription(chatId, intent.taskDescription);

  if (!task) {
    const response =
      "I couldn't find a pending task to mark as done. You can say 'list tasks' to see your pending items.";
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // Cancel any scheduled reminder/nag for this task
  if (task.qstashMessageId) {
    await cancelScheduledMessage(task.qstashMessageId);
  }

  // Complete the task
  await redis.completeTask(chatId, task.id);

  const response = `🎉 Awesome! Marked *${task.content}* as done. Great job!`;
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleCancelTask(
  chatId: number,
  intent: { type: "cancel_task"; taskDescription?: string },
): Promise<string> {
  // Find the task
  const task = await redis.findTaskByDescription(chatId, intent.taskDescription);

  if (!task) {
    const response =
      "I couldn't find a pending task to cancel. You can say 'list tasks' to see your pending items.";
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // Cancel any scheduled reminder/nag for this task
  if (task.qstashMessageId) {
    await cancelScheduledMessage(task.qstashMessageId);
  }

  // Delete the task
  await redis.deleteTask(chatId, task.id);

  const response = `✅ Cancelled *${task.content}*. No worries, priorities change!`;
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleListTasks(chatId: number): Promise<string> {
  const tasks = await redis.getPendingTasks(chatId);

  if (tasks.length === 0) {
    const response = "You have no pending tasks or reminders. Enjoy the mental clarity! 🧘";
    await telegram.sendMessage(chatId, response);
    return response;
  }

  const taskList = tasks
    .map((t, i) => {
      const timeStr = formatFutureTime(t.nextReminder);
      const important = t.isImportant ? " ⚡" : "";
      return `${i + 1}. ${t.content}${important}\n   ⏰ ${timeStr}`;
    })
    .join("\n\n");

  const response = `📋 *Your pending tasks:*\n\n${taskList}\n\nReply "done" when you complete something!`;
  await telegram.sendMessage(chatId, response);
  return response;
}

function formatDelay(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  return `${hours}h ${remainingMinutes}m`;
}

function formatFutureTime(timestamp: number): string {
  const now = Date.now();
  const diff = timestamp - now;

  if (diff <= 0) {
    return "any moment now";
  }

  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) {
    return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  }

  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

async function handleCheckinResponse(
  chatId: number,
  intent: { type: "checkin_response"; rating: number; notes?: string },
): Promise<string> {
  // Save the check-in
  await redis.saveCheckIn(chatId, intent.rating, intent.notes);

  // Clear the awaiting state
  await redis.clearAwaitingCheckin(chatId);

  const notesAck = intent.notes ? " I've noted your thoughts too." : "";
  const response = `Got it! Logged your check-in: ${intent.rating}/5.${notesAck} Keep it up!`;
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleSetCheckinTime(
  chatId: number,
  intent: { type: "set_checkin_time"; hour: number; minute: number },
): Promise<string> {
  const { hour, minute } = intent;

  // Get existing preferences to check for old schedule
  const existingPrefs = await redis.getUserPreferences(chatId);

  // Delete old schedules if they exist
  if (existingPrefs?.checkinScheduleId) {
    await deleteSchedule(existingPrefs.checkinScheduleId);
  }
  if (existingPrefs?.weeklySummaryScheduleId) {
    await deleteSchedule(existingPrefs.weeklySummaryScheduleId);
  }
  if (existingPrefs?.dailySummaryScheduleId) {
    await deleteSchedule(existingPrefs.dailySummaryScheduleId);
  }

  // Create new cron expressions (minute hour * * *)
  const cronExpression = `${minute} ${hour} * * *`;
  const weeklyCron = `${minute} ${hour} * * 0`; // Same time on Sundays

  // Schedule new check-in, daily summary, and weekly summary
  const checkinScheduleId = await scheduleDailyCheckin(chatId, cronExpression);
  const dailySummaryScheduleId = await scheduleDailySummary(chatId, cronExpression);
  const weeklySummaryScheduleId = await scheduleWeeklySummary(chatId, weeklyCron);

  // Save preferences with all schedule IDs
  const prefs = await redis.setCheckinTime(chatId, hour, minute, checkinScheduleId);
  prefs.weeklySummaryScheduleId = weeklySummaryScheduleId;
  prefs.dailySummaryScheduleId = dailySummaryScheduleId;
  await redis.saveUserPreferences(prefs);

  // Format time for display
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const displayMinute = minute.toString().padStart(2, "0");
  const timeStr = `${displayHour}:${displayMinute} ${period}`;

  const response = `Done! I'll check in with you daily at ${timeStr}. You'll also get a daily summary and a weekly summary on Sundays at the same time.`;
  await telegram.sendMessage(chatId, response);
  return response;
}

async function setupDefaultSchedules(chatId: number): Promise<void> {
  // Default check-in time: 8 PM (20:00)
  const defaultHour = 20;
  const defaultMinute = 0;

  try {
    // Create cron expressions
    const cronExpression = `${defaultMinute} ${defaultHour} * * *`;
    const weeklyCron = `${defaultMinute} ${defaultHour} * * 0`; // Sundays

    // Schedule all recurring notifications
    const checkinScheduleId = await scheduleDailyCheckin(chatId, cronExpression);
    const dailySummaryScheduleId = await scheduleDailySummary(chatId, cronExpression);
    const weeklySummaryScheduleId = await scheduleWeeklySummary(chatId, weeklyCron);

    // Save preferences
    const prefs = await redis.setCheckinTime(chatId, defaultHour, defaultMinute, checkinScheduleId);
    prefs.dailySummaryScheduleId = dailySummaryScheduleId;
    prefs.weeklySummaryScheduleId = weeklySummaryScheduleId;
    await redis.saveUserPreferences(prefs);

    console.log(`Set up default schedules for new user ${chatId}`);
  } catch (error) {
    console.error(`Failed to set up default schedules for ${chatId}:`, error);
    // Don't throw - this is a nice-to-have, not critical
  }
}
