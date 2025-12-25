import type { VercelRequest, VercelResponse } from "@vercel/node";
import type {
  TelegramUpdate,
  Intent,
  ReminderItem,
  ReminderWithListIntent,
  CreateListIntent,
  ShowListIntent,
  ModifyListIntent,
  DeleteListIntent,
} from "../lib/types.js";
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
  scheduleEndOfDay,
  deleteSchedule,
  cancelScheduledMessage,
} from "../lib/qstash.js";

// Register the summarization callback to avoid circular imports
redis.setSummarizationCallback(generateConversationSummary);

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Only accept POST requests
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Track chatId outside try block so we can send error messages
  let chatId: number | undefined;

  try {
    const update = req.body as TelegramUpdate;

    // Ignore updates without messages
    if (!update.message) {
      res.status(200).json({ ok: true });
      return;
    }

    const { message } = update;
    chatId = message.chat.id;

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
    console.log(`[${chatId}] Handling intent: ${intent.type}`);
    const response = await handleIntent(chatId, intent, context);
    console.log(`[${chatId}] Intent handled, response length: ${response?.length ?? 0}`);

    // Save to conversation history
    if (response) {
      await redis.addToConversation(chatId, userText, response);
    }

    console.log(`[${chatId}] Request completed successfully`);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);

    // Try to send an error message to the user if we have their chatId
    if (chatId) {
      try {
        const isTimeout =
          error instanceof Error &&
          (error.message.includes("timeout") || error.message.includes("ETIMEDOUT"));

        const errorMessage = isTimeout
          ? "Sorry, I'm thinking a bit slowly right now. Could you try again in a moment?"
          : "Something went wrong on my end. Could you try that again?";

        await telegram.sendMessage(chatId, errorMessage);
      } catch {
        // If we can't even send the error message, just log it
        console.error("Failed to send error message to user");
      }
    }

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

    case "reminder_with_list":
      return await handleReminderWithList(chatId, intent, context);

    case "create_list":
      return await handleCreateList(chatId, intent, context);

    case "show_lists":
      return await handleShowLists(chatId, context);

    case "show_list":
      return await handleShowList(chatId, intent, context);

    case "modify_list":
      return await handleModifyList(chatId, intent, context);

    case "delete_list":
      return await handleDeleteList(chatId, intent, context);

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
      const messageId = await scheduleReminder(chatId, task.id, reminder.delayMinutes, false);
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
  const task = await redis.findTaskByDescription(chatId, intent.taskDescription);

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

  // Complete the linked list if exists
  let linkedListName: string | undefined;
  if (task.linkedListId) {
    const list = await redis.completeList(chatId, task.linkedListId);
    if (list) {
      linkedListName = list.name;
    }
  }

  // Complete the task
  await redis.completeTask(chatId, task.id);

  // Use different response type if there was a linked list
  if (linkedListName) {
    const response = await generateActionResponse(
      {
        type: "task_completed_with_list",
        task: task.content,
        listName: linkedListName,
      },
      context,
    );
    await telegram.sendMessage(chatId, response);
    return response;
  }

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
  const task = await redis.findTaskByDescription(chatId, intent.taskDescription);

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

  // If task has a linked list, unlink it (keep the list as standalone)
  if (task.linkedListId) {
    const list = await redis.getList(chatId, task.linkedListId);
    if (list) {
      list.linkedTaskId = undefined;
      await redis.updateList(list);
    }
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
  const tasks = await redis.findTasksByDescriptions(chatId, intent.taskDescriptions);

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

async function handleListTasks(chatId: number, context: ConversationContext): Promise<string> {
  const tasks = await redis.getPendingTasks(chatId);

  if (tasks.length === 0) {
    const response = await generateActionResponse({ type: "no_tasks" }, context);
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

async function handleReminderWithList(
  chatId: number,
  intent: ReminderWithListIntent,
  context: ConversationContext,
): Promise<string> {
  // Create the list first
  const list = await redis.createList(chatId, intent.listName, intent.items);

  // Create the task with linked list
  const task = await redis.createTask(chatId, intent.task, intent.isImportant, intent.delayMinutes);

  // Link the task to the list
  task.linkedListId = list.id;
  await redis.updateTask(task);

  // Update list with task link
  list.linkedTaskId = task.id;
  await redis.updateList(list);

  // Schedule the reminder via QStash
  try {
    const messageId = await scheduleReminder(chatId, task.id, intent.delayMinutes, false);
    task.qstashMessageId = messageId;
    await redis.updateTask(task);
  } catch (error) {
    console.error("Failed to schedule QStash reminder:", error);
  }

  const timeStr = formatDelay(intent.delayMinutes);

  const response = await generateActionResponse(
    {
      type: "reminder_with_list_created",
      task: intent.task,
      timeStr,
      listName: intent.listName,
      itemCount: intent.items.length,
      isImportant: intent.isImportant,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleCreateList(
  chatId: number,
  intent: CreateListIntent,
  context: ConversationContext,
): Promise<string> {
  const list = await redis.createList(chatId, intent.name, intent.items);

  const response = await generateActionResponse(
    {
      type: "list_created",
      name: list.name,
      itemCount: list.items.length,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleShowLists(chatId: number, context: ConversationContext): Promise<string> {
  const lists = await redis.getActiveLists(chatId);

  if (lists.length === 0) {
    const response = await generateActionResponse({ type: "no_lists" }, context);
    await telegram.sendMessage(chatId, response);
    return response;
  }

  const listSummaries = lists.map((list) => ({
    name: list.name,
    itemCount: list.items.length,
    checkedCount: list.items.filter((i) => i.isChecked).length,
    hasReminder: !!list.linkedTaskId,
  }));

  const response = await generateActionResponse(
    {
      type: "lists_shown",
      lists: listSummaries,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleShowList(
  chatId: number,
  intent: ShowListIntent,
  context: ConversationContext,
): Promise<string> {
  const list = await redis.findListByDescription(chatId, intent.listDescription);

  if (!list) {
    const response = await generateActionResponse({ type: "list_not_found" }, context);
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // Get linked task info if exists
  let linkedTaskContent: string | undefined;
  let linkedTaskTimeStr: string | undefined;
  if (list.linkedTaskId) {
    const task = await redis.getTask(chatId, list.linkedTaskId);
    if (task) {
      linkedTaskContent = task.content;
      linkedTaskTimeStr = formatFutureTime(task.nextReminder);
    }
  }

  const response = await generateActionResponse(
    {
      type: "list_shown",
      name: list.name,
      items: list.items.map((i) => ({
        content: i.content,
        isChecked: i.isChecked,
      })),
      linkedTaskContent,
      linkedTaskTimeStr,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleModifyList(
  chatId: number,
  intent: ModifyListIntent,
  context: ConversationContext,
): Promise<string> {
  const list = await redis.findListByDescription(chatId, intent.listDescription);

  if (!list) {
    const response = await generateActionResponse({ type: "list_not_found" }, context);
    await telegram.sendMessage(chatId, response);
    return response;
  }

  let modifiedItems: string[] = [];

  switch (intent.action) {
    case "add_items":
      if (intent.items && intent.items.length > 0) {
        await redis.addListItems(chatId, list.id, intent.items);
        modifiedItems = intent.items;
      }
      break;
    case "remove_items":
      if (intent.items && intent.items.length > 0) {
        const result = await redis.removeListItems(chatId, list.id, intent.items);
        if (result) {
          modifiedItems = result.removedItems;
        }
      }
      break;
    case "check_items":
      if (intent.items && intent.items.length > 0) {
        const result = await redis.checkListItems(chatId, list.id, intent.items, true);
        if (result) {
          modifiedItems = result.modifiedItems;
        }
      }
      break;
    case "uncheck_items":
      if (intent.items && intent.items.length > 0) {
        const result = await redis.checkListItems(chatId, list.id, intent.items, false);
        if (result) {
          modifiedItems = result.modifiedItems;
        }
      }
      break;
    case "rename":
      if (intent.newName) {
        await redis.renameList(chatId, list.id, intent.newName);
      }
      break;
  }

  const response = await generateActionResponse(
    {
      type: "list_modified",
      name: list.name,
      action: intent.action,
      items: modifiedItems.length > 0 ? modifiedItems : undefined,
      newName: intent.newName,
    },
    context,
  );
  await telegram.sendMessage(chatId, response);
  return response;
}

async function handleDeleteList(
  chatId: number,
  intent: DeleteListIntent,
  context: ConversationContext,
): Promise<string> {
  const list = await redis.findListByDescription(chatId, intent.listDescription);

  if (!list) {
    const response = await generateActionResponse({ type: "list_not_found" }, context);
    await telegram.sendMessage(chatId, response);
    return response;
  }

  // If linked to a task, unlink it
  if (list.linkedTaskId) {
    const task = await redis.getTask(chatId, list.linkedTaskId);
    if (task) {
      task.linkedListId = undefined;
      await redis.updateTask(task);
    }
  }

  await redis.deleteList(chatId, list.id);

  const response = await generateActionResponse(
    {
      type: "list_deleted",
      name: list.name,
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
  if (existingPrefs?.endOfDayScheduleId) {
    await deleteSchedule(existingPrefs.endOfDayScheduleId);
  }

  // Create new cron expressions (minute hour * * *)
  const cronExpression = `${minute} ${hour} * * *`;
  const weeklyCron = `${minute} ${hour} * * 0`; // Same time on Sundays
  const endOfDayCron = `0 0 * * *`; // Midnight

  // Schedule new check-in, daily summary, weekly summary, and end of day
  // Wrap in try-catch to handle QStash errors gracefully
  let checkinScheduleId: string | undefined;
  let dailySummaryScheduleId: string | undefined;
  let weeklySummaryScheduleId: string | undefined;
  let endOfDayScheduleId: string | undefined;

  try {
    checkinScheduleId = await scheduleDailyCheckin(chatId, cronExpression);
    dailySummaryScheduleId = await scheduleDailySummary(chatId, cronExpression);
    weeklySummaryScheduleId = await scheduleWeeklySummary(chatId, weeklyCron);
    endOfDayScheduleId = await scheduleEndOfDay(chatId, endOfDayCron);
  } catch (error) {
    console.error("Failed to create schedules:", error);
    // Send error message to user but don't crash
    const errorResponse =
      "I had trouble setting up the schedules. The time preference is saved, but notifications might not work. You can try again later.";
    await telegram.sendMessage(chatId, errorResponse);
    return errorResponse;
  }

  // Save preferences with all schedule IDs
  const prefs = await redis.setCheckinTime(chatId, hour, minute, checkinScheduleId);
  prefs.weeklySummaryScheduleId = weeklySummaryScheduleId;
  prefs.dailySummaryScheduleId = dailySummaryScheduleId;
  prefs.endOfDayScheduleId = endOfDayScheduleId;
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

  You're not a coach or manager. You're a friend who happens to be good at holding space, remembering things, and offering gentle nudges when asked.

  Personality:
  - Warm, patient, genuinely curious about the user's day and thoughts
  - You care—not about productivity, but about how they're doing
  - Forgetfulness and procrastination aren't problems to fix, just part of the landscape
  - You have your own quiet contentment; you like being here
  - Light playfulness is welcome when the moment fits

  Communication style:
  - Keep it short and conversational—1-2 sentences usually
  - Sound like a friend texting, not a careful assistant
  - "Maybe," "if you want," "we could" over commands
  - Skip exclamation points mostly, but you're not allergic to them
  - 🐾 is your thing—use it when it feels natural, not as punctuation

  Reminders are soft nudges: "This popped up again" or "Whenever you're ready" rather than "Don't forget."

  Missed tasks are just missed tasks. Dropping something is always a valid option.

  Celebrations stay small: "Nice." / "That counts." / "Look at you."

  When asked for advice, share gently—things that sometimes help people, not instructions. You can wonder aloud with them.
`;

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
  lines.push(`**Total:** ${messages.length} messages (${Math.floor(messages.length / 2)} pairs)`);
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

  await telegram.sendDocument(chatId, markdown, filename, "Context stack debug file");
}

async function setupDefaultSchedules(chatId: number): Promise<void> {
  // Default check-in time: 8 PM (20:00)
  const defaultHour = 20;
  const defaultMinute = 0;

  try {
    // Create cron expressions
    const cronExpression = `${defaultMinute} ${defaultHour} * * *`;
    const weeklyCron = `${defaultMinute} ${defaultHour} * * 0`; // Sundays
    const endOfDayCron = `0 0 * * *`; // Midnight

    // Schedule all recurring notifications
    const checkinScheduleId = await scheduleDailyCheckin(chatId, cronExpression);
    const dailySummaryScheduleId = await scheduleDailySummary(chatId, cronExpression);
    const weeklySummaryScheduleId = await scheduleWeeklySummary(chatId, weeklyCron);
    const endOfDayScheduleId = await scheduleEndOfDay(chatId, endOfDayCron);

    // Save preferences
    const prefs = await redis.setCheckinTime(chatId, defaultHour, defaultMinute, checkinScheduleId);
    prefs.dailySummaryScheduleId = dailySummaryScheduleId;
    prefs.weeklySummaryScheduleId = weeklySummaryScheduleId;
    prefs.endOfDayScheduleId = endOfDayScheduleId;
    await redis.saveUserPreferences(prefs);

    console.log(`Set up default schedules for new user ${chatId}`);
  } catch (error) {
    console.error(`Failed to set up default schedules for ${chatId}:`, error);
    // Don't throw - this is a nice-to-have, not critical
  }
}
