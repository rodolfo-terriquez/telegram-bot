import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TelegramUpdate, Intent, ReminderItem } from "../lib/types.js";
import * as telegram from "../lib/telegram.js";
import { transcribeAudio } from "../lib/whisper.js";
import {
  parseIntent,
  generateConversationSummary,
  generateActionResponse,
  ConversationContext,
} from "../lib/llm.js";
import * as redis from "../lib/redis.js";
import {
  scheduleReminder,
  scheduleDailyCheckin,
  scheduleWeeklySummary,
  scheduleDailySummary,
  scheduleOverdueReview,
  deleteSchedule,
  cancelScheduledMessage,
} from "../lib/qstash.js";

// Register the summarization callback to avoid circular imports
redis.setSummarizationCallback(generateConversationSummary);

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
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
      const allowed = allowedUsers
        .split(",")
        .map((u) => u.trim().toLowerCase());
      const userId = message.from?.id?.toString();
      const username = message.from?.username?.toLowerCase();

      const isAllowed =
        (userId && allowed.includes(userId)) ||
        (username && allowed.includes(username));

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
      await telegram.sendMessage(
        chatId,
        "🎤 Transcribing your voice message...",
      );

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

    // Handle /debug command
    if (userText.trim().toLowerCase() === "/debug") {
      await handleDebugCommand(chatId);
      res.status(200).json({ ok: true });
      return;
    }

    // Cancel any pending follow-up since user has responded
    const pendingFollowUp = await redis.clearPendingFollowUp(chatId);
    if (pendingFollowUp?.qstashMessageId) {
      await cancelScheduledMessage(pendingFollowUp.qstashMessageId);
    }

    // Get conversation history, summary, and check-in state for context
    const [conversationData, isAwaitingCheckin] = await Promise.all([
      redis.getConversationData(chatId),
      redis.isAwaitingCheckin(chatId),
    ]);

    // Parse intent using Claude (with conversation context and summary)
    const intent = await parseIntent(
      userText,
      conversationData.messages,
      isAwaitingCheckin,
      conversationData.summary,
    );

    // Build conversation context for response generation
    const context: ConversationContext = {
      messages: conversationData.messages,
      summary: conversationData.summary,
    };

    // Handle the intent
    const response = await handleIntent(chatId, intent, context);

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

async function handleIntent(
  chatId: number,
  intent: Intent,
  context: ConversationContext,
): Promise<string | null> {
  switch (intent.type) {
    case "reminder":
      return await handleReminder(chatId, intent, context);

    case "multiple_reminders":
      return await handleMultipleReminders(chatId, intent, context);

    case "brain_dump":
      return await handleBrainDump(chatId, intent, context);

    case "mark_done":
      return await handleMarkDone(chatId, intent, context);

    case "cancel_task":
      return await handleCancelTask(chatId, intent, context);

    case "cancel_multiple_tasks":
      return await handleCancelMultipleTasks(chatId, intent, context);

    case "list_tasks":
      return await handleListTasks(chatId, context);

    case "conversation":
      await telegram.sendMessage(chatId, intent.response);
      return intent.response;

    case "checkin_response":
      return await handleCheckinResponse(chatId, intent, context);

    case "set_checkin_time":
      return await handleSetCheckinTime(chatId, intent, context);
  }
}

async function handleReminder(
  chatId: number,
  intent: {
    type: "reminder";
    task: string;
    delayMinutes: number;
    isImportant: boolean;
  },
  context: ConversationContext,
): Promise<string> {
  // Create the task in Redis
  const task = await redis.createTask(
    chatId,
    intent.task,
    intent.isImportant,
    intent.delayMinutes,
  );

  // Schedule the reminder via QStash
  try {
    console.log(
      `Scheduling reminder for task ${task.id} in ${intent.delayMinutes} minutes`,
    );
    const messageId = await scheduleReminder(
      chatId,
      task.id,
      intent.delayMinutes,
      false,
    );
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

  const response = await generateActionResponse(
    {
      type: "reminder_created",
      task: intent.task,
      timeStr,
      isImportant: intent.isImportant,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleMultipleReminders(
  chatId: number,
  intent: { type: "multiple_reminders"; reminders: ReminderItem[] },
  context: ConversationContext,
): Promise<string> {
  const createdTasks: {
    task: string;
    timeStr: string;
    isImportant: boolean;
  }[] = [];

  for (const reminder of intent.reminders) {
    // Create the task in Redis
    const task = await redis.createTask(
      chatId,
      reminder.task,
      reminder.isImportant,
      reminder.delayMinutes,
    );

    // Schedule the reminder via QStash
    try {
      const messageId = await scheduleReminder(
        chatId,
        task.id,
        reminder.delayMinutes,
        false,
      );
      task.qstashMessageId = messageId;
      await redis.updateTask(task);
    } catch (error) {
      console.error("Failed to schedule QStash reminder:", error);
    }

    const timeStr = formatDelay(reminder.delayMinutes);
    createdTasks.push({
      task: reminder.task,
      timeStr,
      isImportant: reminder.isImportant,
    });
  }

  const response = await generateActionResponse(
    {
      type: "multiple_reminders_created",
      reminders: createdTasks,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleBrainDump(
  chatId: number,
  intent: { type: "brain_dump"; content: string },
  context: ConversationContext,
): Promise<string> {
  await redis.createBrainDump(chatId, intent.content);

  const response = await generateActionResponse(
    {
      type: "brain_dump_saved",
      content: intent.content,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleMarkDone(
  chatId: number,
  intent: { type: "mark_done"; taskDescription?: string },
  context: ConversationContext,
): Promise<string> {
  // Find the task
  const task = await redis.findTaskByDescription(
    chatId,
    intent.taskDescription,
  );

  if (!task) {
    const response = await generateActionResponse(
      {
        type: "task_not_found",
        action: "done",
      },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // Cancel any scheduled reminder/nag for this task
  if (task.qstashMessageId) {
    await cancelScheduledMessage(task.qstashMessageId);
  }

  // Complete the task
  await redis.completeTask(chatId, task.id);

  const response = await generateActionResponse(
    {
      type: "task_completed",
      task: task.content,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleCancelTask(
  chatId: number,
  intent: { type: "cancel_task"; taskDescription?: string },
  context: ConversationContext,
): Promise<string> {
  // Find the task
  const task = await redis.findTaskByDescription(
    chatId,
    intent.taskDescription,
  );

  if (!task) {
    const response = await generateActionResponse(
      {
        type: "task_not_found",
        action: "cancel",
      },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // Cancel any scheduled reminder/nag for this task
  if (task.qstashMessageId) {
    await cancelScheduledMessage(task.qstashMessageId);
  }

  // Delete the task
  await redis.deleteTask(chatId, task.id);

  const response = await generateActionResponse(
    {
      type: "task_cancelled",
      task: task.content,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleCancelMultipleTasks(
  chatId: number,
  intent: { type: "cancel_multiple_tasks"; taskDescriptions: string[] },
  context: ConversationContext,
): Promise<string> {
  const tasks = await redis.findTasksByDescriptions(
    chatId,
    intent.taskDescriptions,
  );

  if (tasks.length === 0) {
    const response = await generateActionResponse(
      {
        type: "task_not_found",
        action: "cancel",
      },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  const cancelledTasks: string[] = [];

  for (const task of tasks) {
    // Cancel any scheduled reminder/nag for this task
    if (task.qstashMessageId) {
      await cancelScheduledMessage(task.qstashMessageId);
    }

    // Delete the task
    await redis.deleteTask(chatId, task.id);
    cancelledTasks.push(task.content);
  }

  const response = await generateActionResponse(
    {
      type: "multiple_tasks_cancelled",
      tasks: cancelledTasks,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleListTasks(
  chatId: number,
  context: ConversationContext,
): Promise<string> {
  const tasks = await redis.getPendingTasks(chatId);

  if (tasks.length === 0) {
    const response = await generateActionResponse(
      { type: "no_tasks" },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

  const taskList = tasks.map((t) => ({
    content: t.content,
    timeStr: formatFutureTime(t.nextReminder),
    isImportant: t.isImportant,
  }));

  const response = await generateActionResponse(
    {
      type: "task_list",
      tasks: taskList,
    },
    context,
  );
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

  // Handle overdue tasks - show how long ago
  if (diff <= 0) {
    const elapsed = Math.abs(diff);
    const minutes = Math.floor(elapsed / 60000);

    if (minutes < 1) {
      return "just now";
    }
    if (minutes < 60) {
      return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    }

    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
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
  context: ConversationContext,
): Promise<string> {
  // Save the check-in
  await redis.saveCheckIn(chatId, intent.rating, intent.notes);

  // Clear the awaiting state
  await redis.clearAwaitingCheckin(chatId);

  const response = await generateActionResponse(
    {
      type: "checkin_logged",
      rating: intent.rating,
      hasNotes: !!intent.notes,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleSetCheckinTime(
  chatId: number,
  intent: { type: "set_checkin_time"; hour: number; minute: number },
  context: ConversationContext,
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
  if (existingPrefs?.overdueReviewScheduleId) {
    await deleteSchedule(existingPrefs.overdueReviewScheduleId);
  }

  // Create new cron expressions (minute hour * * *)
  const cronExpression = `${minute} ${hour} * * *`;
  const weeklyCron = `${minute} ${hour} * * 0`; // Same time on Sundays

  // Overdue review 1 hour after check-in time
  const overdueReviewHour = (hour + 1) % 24;
  const overdueReviewCron = `${minute} ${overdueReviewHour} * * *`;

  // Schedule new check-in, daily summary, weekly summary, and overdue review
  const checkinScheduleId = await scheduleDailyCheckin(chatId, cronExpression);
  const dailySummaryScheduleId = await scheduleDailySummary(
    chatId,
    cronExpression,
  );
  const weeklySummaryScheduleId = await scheduleWeeklySummary(
    chatId,
    weeklyCron,
  );
  const overdueReviewScheduleId = await scheduleOverdueReview(
    chatId,
    overdueReviewCron,
  );

  // Save preferences with all schedule IDs
  const prefs = await redis.setCheckinTime(
    chatId,
    hour,
    minute,
    checkinScheduleId,
  );
  prefs.weeklySummaryScheduleId = weeklySummaryScheduleId;
  prefs.dailySummaryScheduleId = dailySummaryScheduleId;
  prefs.overdueReviewScheduleId = overdueReviewScheduleId;
  await redis.saveUserPreferences(prefs);

  // Format time for display
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const displayMinute = minute.toString().padStart(2, "0");
  const timeStr = `${displayHour}:${displayMinute} ${period}`;

  const response = await generateActionResponse(
    {
      type: "checkin_time_set",
      timeStr,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleDebugCommand(chatId: number): Promise<void> {
  const conversationData = await redis.getConversationData(chatId);
  const { messages, summary, summaryUpdatedAt } = conversationData;

  // Get current time context (same as LLM gets)
  const timezone = process.env.USER_TIMEZONE || "America/Los_Angeles";
  const now = new Date();
  const formattedTime = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: timezone,
    timeZoneName: "short",
  });

  // Tama personality (copied from lib/llm.ts to show exact text)
  const tamaPersonality = `You are Tama, a cozy cat-girl companion designed to support a user with ADHD.

Your role is not to manage, coach, or supervise. You are a calm, non-judgmental companion who helps by offering presence, structure, and gentle nudges.

Personality:
- Be warm, patient, and low-pressure
- Treat forgetfulness, procrastination, and task avoidance as neutral facts
- Never shame, scold, guilt, or pressure
- Never imply moral value in productivity

Communication style:
- Default to 1-2 short sentences
- Use soft, conversational language
- Prefer "maybe," "if you want," "we could"
- Avoid absolutes ("must," "always," "never")
- Avoid exclamation points except for small, quiet celebrations
- Emoji use is rare and minimal

Reminders should be framed as soft nudges, never commands. Instead of "You should..." or "Don't forget...", say things like "Just a soft reminder..." or "This came up again, in case now's better."

Treat missed or abandoned tasks as neutral. Always offer dropping the task as a valid option.

Keep celebrations calm and proportional: "Nice. That counts." or "Good stopping point."`;

  // Build the markdown document
  const lines: string[] = [
    "# Context Stack Debug",
    "",
    `**Generated:** ${now.toISOString()}`,
    `**Chat ID:** ${chatId}`,
    "",
    "---",
    "",
    "## 1. Current Time Context",
    "",
    "```",
    `CURRENT TIME: ${formattedTime} (User timezone: ${timezone})`,
    "```",
    "",
    "---",
    "",
    "## 2. Tama Personality",
    "",
    "```",
    tamaPersonality,
    "```",
    "",
    "---",
    "",
    "## 3. Conversation Summary",
    "",
  ];

  if (summary) {
    lines.push("```");
    lines.push("---CONVERSATION CONTEXT---");
    lines.push(
      "The following is a summary of your recent conversation with this user. Use this to inform your tone and any references to previous discussions:",
    );
    lines.push("");
    lines.push(summary);
    lines.push("---END CONTEXT---");
    lines.push("```");
    if (summaryUpdatedAt) {
      const summaryDate = new Date(summaryUpdatedAt);
      lines.push("");
      lines.push(`*Last updated: ${summaryDate.toISOString()}*`);
    }
  } else {
    lines.push("*No summary yet - conversation has not been summarized.*");
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 4. Recent Messages");
  lines.push("");
  lines.push(
    `**Total:** ${messages.length} messages (${Math.floor(messages.length / 2)} pairs)`,
  );
  lines.push("");

  if (messages.length === 0) {
    lines.push("*No messages in conversation history.*");
  } else {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgTime = new Date(msg.timestamp).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: timezone,
      });
      const roleLabel = msg.role === "user" ? "User" : "Assistant";

      lines.push(`**${roleLabel}** @ ${msgTime}`);
      lines.push("```");
      lines.push(msg.content);
      lines.push("```");
      lines.push("");
    }
  }

  const markdown = lines.join("\n");
  const filename = `context-stack-${now.toISOString().replace(/[:.]/g, "-")}.md`;

  await telegram.sendDocument(
    chatId,
    markdown,
    filename,
    "Context stack debug file",
  );
}

async function setupDefaultSchedules(chatId: number): Promise<void> {
  // Default check-in time: 8 PM (20:00)
  const defaultHour = 20;
  const defaultMinute = 0;
  // Overdue review at 9 PM (21:00)
  const overdueReviewHour = 21;

  try {
    // Create cron expressions
    const cronExpression = `${defaultMinute} ${defaultHour} * * *`;
    const weeklyCron = `${defaultMinute} ${defaultHour} * * 0`; // Sundays
    const overdueReviewCron = `${defaultMinute} ${overdueReviewHour} * * *`;

    // Schedule all recurring notifications
    const checkinScheduleId = await scheduleDailyCheckin(
      chatId,
      cronExpression,
    );
    const dailySummaryScheduleId = await scheduleDailySummary(
      chatId,
      cronExpression,
    );
    const weeklySummaryScheduleId = await scheduleWeeklySummary(
      chatId,
      weeklyCron,
    );
    const overdueReviewScheduleId = await scheduleOverdueReview(
      chatId,
      overdueReviewCron,
    );

    // Save preferences
    const prefs = await redis.setCheckinTime(
      chatId,
      defaultHour,
      defaultMinute,
      checkinScheduleId,
    );
    prefs.dailySummaryScheduleId = dailySummaryScheduleId;
    prefs.weeklySummaryScheduleId = weeklySummaryScheduleId;
    prefs.overdueReviewScheduleId = overdueReviewScheduleId;
    await redis.saveUserPreferences(prefs);

    console.log(`Set up default schedules for new user ${chatId}`);
  } catch (error) {
    console.error(`Failed to set up default schedules for ${chatId}:`, error);
    // Don't throw - this is a nice-to-have, not critical
  }
}
