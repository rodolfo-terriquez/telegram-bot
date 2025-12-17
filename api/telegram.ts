import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TelegramUpdate, Intent } from "../lib/types.js";
import * as telegram from "../lib/telegram.js";
import { transcribeAudio } from "../lib/whisper.js";
import { parseIntent, calculateNextNagDelay } from "../lib/claude.js";
import * as redis from "../lib/redis.js";
import { scheduleReminder } from "../lib/qstash.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
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
      const allowed = allowedUsers.split(",").map((u) => u.trim().toLowerCase());
      const userId = message.from?.id?.toString();
      const username = message.from?.username?.toLowerCase();

      const isAllowed =
        (userId && allowed.includes(userId)) ||
        (username && allowed.includes(username));

      if (!isAllowed) {
        console.log(`Unauthorized user: ${username} (${userId})`);
        await telegram.sendMessage(
          chatId,
          "Sorry, this bot is private. Contact the owner for access."
        );
        res.status(200).json({ ok: true });
        return;
      }
    }

    // Register this chat for daily summaries
    await redis.registerChat(chatId);

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
          "Sorry, I couldn't transcribe that voice message. Please try again or send a text message."
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

    // Parse intent using Claude
    const intent = await parseIntent(userText);

    // Handle the intent
    await handleIntent(chatId, intent);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

async function handleIntent(chatId: number, intent: Intent): Promise<void> {
  switch (intent.type) {
    case "reminder":
      await handleReminder(chatId, intent);
      break;

    case "brain_dump":
      await handleBrainDump(chatId, intent);
      break;

    case "mark_done":
      await handleMarkDone(chatId, intent);
      break;

    case "list_tasks":
      await handleListTasks(chatId);
      break;

    case "conversation":
      await telegram.sendMessage(chatId, intent.response);
      break;
  }
}

async function handleReminder(
  chatId: number,
  intent: { type: "reminder"; task: string; delayMinutes: number; isImportant: boolean }
): Promise<void> {
  // Create the task in Redis
  const task = await redis.createTask(
    chatId,
    intent.task,
    intent.isImportant,
    intent.delayMinutes
  );

  // Schedule the reminder via QStash
  try {
    console.log(`Scheduling reminder for task ${task.id} in ${intent.delayMinutes} minutes`);
    const messageId = await scheduleReminder(
      chatId,
      task.id,
      intent.delayMinutes,
      false
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
  const importantStr = intent.isImportant ? " (I'll nag you until it's done!)" : "";

  await telegram.sendMessage(
    chatId,
    `✅ Got it! I'll remind you to *${intent.task}* in ${timeStr}${importantStr}`
  );
}

async function handleBrainDump(
  chatId: number,
  intent: { type: "brain_dump"; content: string }
): Promise<void> {
  await redis.createBrainDump(chatId, intent.content);

  await telegram.sendMessage(
    chatId,
    `💭 Captured! I've saved that thought. You'll see it in your daily summary.`
  );
}

async function handleMarkDone(
  chatId: number,
  intent: { type: "mark_done"; taskDescription?: string }
): Promise<void> {
  // Find the task
  const task = await redis.findTaskByDescription(chatId, intent.taskDescription);

  if (!task) {
    await telegram.sendMessage(
      chatId,
      "I couldn't find a pending task to mark as done. You can say 'list tasks' to see your pending items."
    );
    return;
  }

  // Complete the task
  await redis.completeTask(chatId, task.id);

  await telegram.sendMessage(
    chatId,
    `🎉 Awesome! Marked *${task.content}* as done. Great job!`
  );
}

async function handleListTasks(chatId: number): Promise<void> {
  const tasks = await redis.getPendingTasks(chatId);

  if (tasks.length === 0) {
    await telegram.sendMessage(
      chatId,
      "You have no pending tasks or reminders. Enjoy the mental clarity! 🧘"
    );
    return;
  }

  const taskList = tasks
    .map((t, i) => {
      const timeStr = formatFutureTime(t.nextReminder);
      const important = t.isImportant ? " ⚡" : "";
      return `${i + 1}. ${t.content}${important}\n   ⏰ ${timeStr}`;
    })
    .join("\n\n");

  await telegram.sendMessage(
    chatId,
    `📋 *Your pending tasks:*\n\n${taskList}\n\nReply "done" when you complete something!`
  );
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

