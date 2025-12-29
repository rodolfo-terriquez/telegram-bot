import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { NotificationPayload } from "../lib/types.js";
import * as telegram from "../lib/telegram.js";
import * as redis from "../lib/redis.js";
import {
  scheduleReminder,
  scheduleFollowUp,
  verifySignature,
} from "../lib/qstash.js";
import {
  generateNaggingMessage,
  calculateNextNagDelay,
  generateCheckinPrompt,
  generateWeeklyInsights,
  generateFollowUpMessage,
  generateReminderMessage,
  generateFinalNagMessage,
  generateEndOfDayMessage,
  generateMorningReviewMessage,
  ConversationContext,
} from "../lib/llm.js";

// Helper to get conversation context for a chat
async function getContext(chatId: number): Promise<ConversationContext> {
  const conversationData = await redis.getConversationData(chatId);
  return {
    messages: conversationData.messages,
    summary: conversationData.summary,
  };
}

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
    // Verify QStash signature
    const signature = req.headers["upstash-signature"] as string;
    const rawBody = JSON.stringify(req.body);

    if (signature) {
      const isValid = await verifySignature(signature, rawBody);
      if (!isValid) {
        console.error("Invalid QStash signature");
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
    }

    const payload = req.body as NotificationPayload;

    switch (payload.type) {
      case "reminder":
        await handleReminder(payload);
        break;

      case "nag":
        await handleNag(payload);
        break;

      case "daily_checkin":
        await handleDailyCheckin(payload);
        break;

      case "weekly_summary":
        await handleWeeklySummary(payload);
        break;

      case "follow_up":
        await handleFollowUp(payload);
        break;

      case "end_of_day":
        await handleEndOfDay(payload);
        break;

      case "morning_review":
        await handleMorningReview(payload);
        break;

      default:
        console.warn("Unknown notification type:", payload);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Notify error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

async function handleReminder(payload: NotificationPayload): Promise<void> {
  const { chatId, taskId } = payload;

  // Get the task
  const task = await redis.getTask(chatId, taskId);
  if (!task || task.status === "completed") {
    // Task was completed or deleted, no action needed
    return;
  }

  // Get conversation context for personality-consistent messaging
  const context = await getContext(chatId);

  // Generate and send the reminder using the LLM for personality-consistent messaging
  const reminderMessage = await generateReminderMessage(task.content, context);
  await telegram.sendMessage(chatId, reminderMessage);

  // Schedule a follow-up in 5-10 minutes in case user doesn't respond
  try {
    const followUpMessageId = await scheduleFollowUp(chatId, taskId);
    await redis.setPendingFollowUp(
      chatId,
      taskId,
      task.content,
      followUpMessageId,
    );
  } catch (error) {
    console.error("Failed to schedule follow-up:", error);
  }

  // If important, schedule the first nag
  if (task.isImportant) {
    const nextDelay = calculateNextNagDelay(0, true);
    const messageId = await scheduleReminder(chatId, taskId, nextDelay, true);

    // Update task with new nag info
    task.naggingLevel = 1;
    task.nextReminder = Date.now() + nextDelay * 60 * 1000;
    task.qstashMessageId = messageId;
    await redis.updateTask(task);
  }
}

async function handleNag(payload: NotificationPayload): Promise<void> {
  const { chatId, taskId } = payload;

  // Get the task
  const task = await redis.getTask(chatId, taskId);
  if (!task || task.status === "completed") {
    // Task was completed, no more nagging needed
    return;
  }

  // Get conversation context
  const context = await getContext(chatId);

  // Generate a contextual nagging message
  const nagMessage = await generateNaggingMessage(
    task,
    task.naggingLevel,
    context,
  );

  await telegram.sendMessage(chatId, nagMessage);

  // Schedule the next nag with escalating delay
  const nextDelay = calculateNextNagDelay(task.naggingLevel, task.isImportant);

  // Cap nagging at level 5 (about 24 hours of nagging)
  if (task.naggingLevel < 5) {
    const messageId = await scheduleReminder(chatId, taskId, nextDelay, true);

    task.naggingLevel += 1;
    task.nextReminder = Date.now() + nextDelay * 60 * 1000;
    task.qstashMessageId = messageId;
    await redis.updateTask(task);
  } else {
    // Final nag - stop nagging but keep task pending
    const finalMessage = await generateFinalNagMessage(task.content, context);
    await telegram.sendMessage(chatId, finalMessage);
  }
}

async function handleDailyCheckin(payload: NotificationPayload): Promise<void> {
  const { chatId } = payload;

  // Get conversation context
  const context = await getContext(chatId);

  // Generate a friendly check-in prompt
  const prompt = await generateCheckinPrompt(context);

  await telegram.sendMessage(chatId, prompt);

  // Mark that we're awaiting a check-in response
  await redis.markAwaitingCheckin(chatId);
}

async function handleWeeklySummary(
  payload: NotificationPayload,
): Promise<void> {
  const { chatId } = payload;

  // Get weekly check-ins and brain dumps
  const [checkIns, dumps, completedTaskCount] = await Promise.all([
    redis.getWeeklyCheckIns(chatId),
    redis.getWeeklyDumps(chatId),
    redis.getWeeklyCompletedTaskCount(chatId),
  ]);

  // Only send if there's any data
  if (checkIns.length === 0 && dumps.length === 0 && completedTaskCount === 0) {
    return;
  }

  // Get conversation context
  const context = await getContext(chatId);

  // Generate weekly insights
  const insights = await generateWeeklyInsights(
    checkIns,
    dumps,
    completedTaskCount,
    context,
  );

  await telegram.sendMessage(chatId, insights);
}

async function handleFollowUp(payload: NotificationPayload): Promise<void> {
  const { chatId, taskId } = payload;

  // Check if there's still a pending follow-up (user hasn't responded)
  const pendingFollowUp = await redis.getPendingFollowUp(chatId);

  if (!pendingFollowUp || pendingFollowUp.taskId !== taskId) {
    // User already responded or follow-up was cancelled, skip
    return;
  }

  // Get the task to make sure it's still pending
  const task = await redis.getTask(chatId, taskId);
  if (!task || task.status === "completed") {
    // Task was completed, no follow-up needed
    await redis.clearPendingFollowUp(chatId);
    return;
  }

  // Get conversation context
  const context = await getContext(chatId);

  // Generate and send a gentle follow-up message
  const followUpMessage = await generateFollowUpMessage(task.content, context);
  await telegram.sendMessage(chatId, followUpMessage);

  // Clear the pending follow-up (we only send one follow-up per reminder)
  await redis.clearPendingFollowUp(chatId);
}

async function handleEndOfDay(payload: NotificationPayload): Promise<void> {
  const { chatId } = payload;

  // Get conversation context
  const context = await getContext(chatId);

  // Generate a gentle end-of-day message
  const message = await generateEndOfDayMessage(context);

  await telegram.sendMessage(chatId, message);
}

async function handleMorningReview(
  payload: NotificationPayload,
): Promise<void> {
  const { chatId } = payload;

  // Get inbox items, overdue tasks, and today's tasks
  const [inboxItems, overdueTasks, todaysTasks] = await Promise.all([
    redis.getUncheckedInboxItems(chatId),
    redis.getOverdueTasks(chatId),
    redis.getTodaysTasks(chatId),
  ]);

  // Get conversation context
  const context = await getContext(chatId);

  // Format overdue tasks with time info
  const formattedOverdue = overdueTasks.map((task) => ({
    content: task.content,
    overdueTime: formatOverdueTime(task.nextReminder),
  }));

  // Format today's tasks with time info
  const formattedToday = todaysTasks.map((task) => ({
    content: task.content,
    scheduledTime: formatScheduledTime(task.nextReminder),
  }));

  // Generate the morning review message
  const message = await generateMorningReviewMessage(
    {
      inboxItems: inboxItems.map((item) => ({ content: item.content })),
      overdueTasks: formattedOverdue,
      todaysTasks: formattedToday,
    },
    context,
  );

  await telegram.sendMessage(chatId, message);
}

function formatScheduledTime(timestamp: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: process.env.USER_TIMEZONE || "America/Los_Angeles",
  });
  return time;
}

function formatOverdueTime(timestamp: number): string {
  const now = Date.now();
  const elapsed = now - timestamp;
  const minutes = Math.floor(elapsed / 60000);

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
