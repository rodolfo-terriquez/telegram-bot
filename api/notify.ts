import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { NotificationPayload } from "../lib/types.js";
import * as telegram from "../lib/telegram.js";
import * as redis from "../lib/redis.js";
import { scheduleReminder, verifySignature } from "../lib/qstash.js";
import {
  generateNaggingMessage,
  generateDailySummary,
  calculateNextNagDelay,
  generateCheckinPrompt,
  generateWeeklyInsights,
} from "../lib/claude.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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

      case "daily_summary":
        await handleDailySummary(payload);
        break;

      case "daily_checkin":
        await handleDailyCheckin(payload);
        break;

      case "weekly_summary":
        await handleWeeklySummary(payload);
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

  // Send the reminder
  await telegram.sendMessage(
    chatId,
    `⏰ *Reminder:* ${task.content}\n\nReply "done" when you've finished!`,
  );

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

  // Generate a contextual nagging message
  const nagMessage = await generateNaggingMessage(task, task.naggingLevel);

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
    await telegram.sendMessage(
      chatId,
      `This was my last reminder about *${task.content}*. It's still in your task list whenever you're ready. No pressure! 💪`,
    );
  }
}

async function handleDailySummary(payload: NotificationPayload): Promise<void> {
  const { chatId } = payload;

  // Get today's brain dumps and pending tasks
  const [dumps, tasks] = await Promise.all([
    redis.getTodaysDumps(chatId),
    redis.getPendingTasks(chatId),
  ]);

  // Only send summary if there's content
  if (dumps.length === 0 && tasks.length === 0) {
    return;
  }

  // Generate AI summary
  const summary = await generateDailySummary(dumps, tasks);

  await telegram.sendMessage(chatId, summary);
}

async function handleDailyCheckin(payload: NotificationPayload): Promise<void> {
  const { chatId } = payload;

  // Generate a friendly check-in prompt
  const prompt = await generateCheckinPrompt();

  await telegram.sendMessage(chatId, prompt);

  // Mark that we're awaiting a check-in response
  await redis.markAwaitingCheckin(chatId);
}

async function handleWeeklySummary(payload: NotificationPayload): Promise<void> {
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

  // Generate weekly insights
  const insights = await generateWeeklyInsights(checkIns, dumps, completedTaskCount);

  await telegram.sendMessage(chatId, insights);
}
