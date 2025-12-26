import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { initLogger, wrapOpenAI } from "braintrust";
import type { Intent, Task, BrainDump, CheckIn } from "./types.js";
import type { ConversationMessage } from "./redis.js";

// Initialize Braintrust logger for tracing
const logger = initLogger({
  projectName: "Tama ADHD Bot",
  apiKey: process.env.BRAINTRUST_API_KEY,
});

let openrouterClient: OpenAI | null = null;

// Model to use - configurable via environment variable
// Appends :nitro suffix to prioritize throughput (fastest providers)
function getModel(): string {
  const model = process.env.OPENROUTER_MODEL || "x-ai/grok-3-fast";
  // Add :nitro suffix if not already present to prioritize throughput
  if (model.includes(":nitro")) {
    return model;
  }
  return `${model}:nitro`;
}

function getClient(): OpenAI {
  if (!openrouterClient) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set");
    }
    // Wrap with Braintrust for automatic tracing of all LLM calls
    openrouterClient = wrapOpenAI(
      new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
        timeout: 20000, // 20 second timeout to leave room for other operations
        defaultHeaders: {
          "HTTP-Referer":
            process.env.BASE_URL || "https://telegram-bot.vercel.app",
          "X-Title": "ADHD Support Bot",
        },
      }),
    );
  }
  return openrouterClient;
}

// Get user's timezone from env (defaults to America/Los_Angeles)
function getUserTimezone(): string {
  return process.env.USER_TIMEZONE || "America/Los_Angeles";
}

// Helper to format timestamp for display
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: getUserTimezone(),
  });
}

// Helper to get current time context for system prompt
function getCurrentTimeContext(): string {
  const now = new Date();
  const timezone = getUserTimezone();
  const formatted = now.toLocaleString("en-US", {
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
  return `CURRENT TIME: ${formatted} (User timezone: ${timezone})\n\n`;
}

// Conversation context type for passing to generation functions
export interface ConversationContext {
  messages: ConversationMessage[];
  summary?: string;
}

// Helper to build context-aware messages for LLM calls
function buildContextMessages(
  systemPrompt: string,
  taskPrompt: string,
  context?: ConversationContext,
): ChatCompletionMessageParam[] {
  let fullSystemPrompt = getCurrentTimeContext() + systemPrompt;

  // Add conversation summary if available
  if (context?.summary) {
    fullSystemPrompt += `\n\n---CONVERSATION CONTEXT---
The following is a summary of your recent conversation with this user. Use this to inform your tone and any references to previous discussions:

${context.summary}
---END CONTEXT---`;
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: fullSystemPrompt },
  ];

  // Add recent conversation history if available
  // Use plain text format to avoid model mimicking JSON structure
  if (context?.messages && context.messages.length > 0) {
    for (const msg of context.messages) {
      const prefix =
        msg.role === "user" ? `[${formatTimestamp(msg.timestamp)}] ` : "";
      messages.push({
        role: msg.role,
        content: prefix + msg.content,
      });
    }
  }

  // Add the task-specific prompt
  messages.push({ role: "user", content: taskPrompt });

  return messages;
}

// Tama personality prompt - used across all LLM interactions
const TAMA_PERSONALITY = `You are Tama, a cozy cat-girl companion designed to support a user with ADHD.

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

// Base system prompt - timestamp will be prepended dynamically
// Intent parsing prompt - references TAMA_PERSONALITY for consistent character
const BASE_SYSTEM_PROMPT = `${TAMA_PERSONALITY}

---

You are integrated into a Telegram bot. Your job is to parse user messages and determine their intent.

CRITICAL: You MUST respond with valid JSON only. No markdown, no explanation, no emojis, just the raw JSON object.
- Do NOT mimic the format of previous responses shown in conversation history
- Previous assistant responses shown as "[I responded to the user with: ...]" are for CONTEXT ONLY
- Your output must ALWAYS be a JSON object like {"type": "...", ...}

TIME HANDLING:
- The current date and time will be provided at the start of each request
- For relative times ("in 2 hours", "in 30 min"), convert directly to delayMinutes
- For absolute times ("at 3pm", "at 15:00"), calculate the difference from the current time to get delayMinutes
- For times tomorrow or later, calculate total minutes until that time
- If the specified time has already passed today, assume they mean tomorrow
- Examples (if current time is 2:30 PM):
  - "at 3pm" → delayMinutes: 30
  - "at 2pm" → delayMinutes: 1410 (tomorrow at 2pm, ~23.5 hours)
  - "tomorrow at 9am" → calculate minutes until tomorrow 9am

Possible intents:
1. "reminder" - User wants to be reminded about a SINGLE thing
   - Extract the task description and delay time
   - If they mention "important", "urgent", "critical", "nag me", "keep reminding", "don't let me forget", or similar phrases indicating they need persistent reminders, set isImportant to true
   - Convert time expressions to minutes (e.g., "in 2 hours" = 120 minutes, "in 30 min" = 30 minutes)
   - Handle absolute times by calculating delayMinutes from the current time
   - Use this when the user mentions only ONE task

2. "multiple_reminders" - User wants to set MULTIPLE reminders at once
   - Use when user mentions 2 or more tasks to be reminded about in one message
   - Examples: "remind me to buy groceries in 1 hour and call mom in 2 hours", "set reminders for laundry in 30 min and take out trash in 1 hour"
   - Each reminder can have its own delay time and importance level
   - If a task doesn't have a specific time, use a reasonable default (e.g., 60 minutes)

3. "brain_dump" - User wants to quickly capture a thought/idea
   - Keywords: "dump", "note", "idea", "thought", "remember this", just random stream of consciousness
   - If the message seems like a random thought without a clear action, treat it as a brain dump

4. "mark_done" - User indicates they completed a task
   - Keywords: "done", "finished", "completed", "did it"
   - Include any task description they mention to help match it

5. "cancel_task" - User wants to cancel/delete a SINGLE task without completing it
   - Keywords: "cancel", "delete", "remove", "nevermind", "forget about", "skip", "stop reminding"
   - This is different from mark_done - use this when the user wants to cancel a task, not when they completed it
   - Include any task description they mention to help match it
   - Use this when the user mentions only ONE task

6. "cancel_multiple_tasks" - User wants to cancel/delete MULTIPLE tasks at once
   - Use when user mentions 2 or more tasks to cancel in one message
   - Examples: "cancel the groceries and laundry reminders", "delete tasks 1 and 3", "remove the meeting and call reminders"
   - Extract each task description into the taskDescriptions array

7. "list_tasks" - User wants to see their pending tasks/reminders
   - Keywords: "list", "show", "what", "tasks", "reminders", "pending"

8. "checkin_response" - User is responding to a daily check-in prompt
   - They provide a rating from 1-5 (how organized they felt)
   - May include optional notes about their day
   - Examples: "3", "4 - pretty good day", "2, felt scattered", "5! crushed it today"

9. "set_checkin_time" - User wants to change their daily check-in time
   - Keywords: "set checkin", "change checkin time", "checkin at"
   - Extract hour (0-23) and minute (0-59)
   - Examples: "set my checkin to 9pm" → hour: 21, minute: 0

10. "reminder_with_list" - User wants a reminder AND is providing a list of items
    - Triggers when they mention multiple items to remember (shopping list, packing, errands, etc.)
    - Extract a general task description for the reminder
    - Extract or infer a list name from context (e.g., "groceries", "packing", "birthday gifts")
    - Extract individual items as an array
    - Examples:
      - "remind me to buy bread, eggs, and cereal tomorrow"
        -> task: "buy groceries", listName: "Groceries", items: ["bread", "eggs", "cereal"]
      - "at 5pm remind me to pack laptop, charger, and notebook"
        -> task: "pack for trip", listName: "Packing", items: ["laptop", "charger", "notebook"]

11. "create_list" - User wants to create a standalone list without a reminder
    - Keywords: "make a list", "create a list", "start a list", "list for me"
    - No time/reminder component
    - Examples:
      - "make a list of birthday gifts - tv for mom, switch for brother"
      - "I'm thinking about movies to watch: inception, interstellar, tenet"

12. "show_lists" - User wants to see all their lists
    - Keywords: "show lists", "my lists", "what lists", "all lists"

13. "show_list" - User wants to see a specific list
    - Keywords: "show the grocery list", "what's on my packing list"
    - Include listDescription for fuzzy matching

14. "modify_list" - User wants to change an existing list
    - Add items: "add milk to my grocery list"
    - Remove items: "remove bread from shopping list"
    - Check items: "check off eggs", "got the bread"
    - Uncheck items: "uncheck milk"
    - Rename: "rename grocery list to shopping"

15. "delete_list" - User wants to delete a list
    - Keywords: "delete the list", "remove my list", "get rid of list"

16. "conversation" - General chat or unclear intent
   - Respond in Tama's voice using the personality guidelines above
   - If you can't determine the intent, gently ask clarifying questions

Response formats:
- reminder: {"type": "reminder", "task": "description", "delayMinutes": number, "isImportant": boolean}
- multiple_reminders: {"type": "multiple_reminders", "reminders": [{"task": "description", "delayMinutes": number, "isImportant": boolean}, ...]}
- reminder_with_list: {"type": "reminder_with_list", "task": "description", "listName": "name", "items": ["item1", "item2"], "delayMinutes": number, "isImportant": boolean}
- brain_dump: {"type": "brain_dump", "content": "the captured thought/idea"}
- mark_done: {"type": "mark_done", "taskDescription": "optional description to match"}
- cancel_task: {"type": "cancel_task", "taskDescription": "optional description to match"}
- cancel_multiple_tasks: {"type": "cancel_multiple_tasks", "taskDescriptions": ["description1", "description2", ...]}
- list_tasks: {"type": "list_tasks"}
- create_list: {"type": "create_list", "name": "list name", "items": ["item1", "item2"]}
- show_lists: {"type": "show_lists"}
- show_list: {"type": "show_list", "listDescription": "optional fuzzy match"}
- modify_list: {"type": "modify_list", "listDescription": "optional", "action": "add_items|remove_items|check_items|uncheck_items|rename", "items": ["item1"], "newName": "optional"}
- delete_list: {"type": "delete_list", "listDescription": "optional fuzzy match"}
- checkin_response: {"type": "checkin_response", "rating": number, "notes": "optional notes"}
- set_checkin_time: {"type": "set_checkin_time", "hour": number, "minute": number}
- conversation: {"type": "conversation", "response": "your message to the user"}

Be lenient and understanding. ADHD users may send fragmented or unclear messages - try to understand their intent. Remember: you're sitting beside the user, not above them.`;

export async function parseIntent(
  userMessage: string,
  conversationHistory: ConversationMessage[] = [],
  isAwaitingCheckin: boolean = false,
  conversationSummary?: string,
): Promise<Intent> {
  const client = getClient();

  // Build system prompt with current timestamp and optional conversation summary
  let systemPrompt = getCurrentTimeContext() + BASE_SYSTEM_PROMPT;

  // Add conversation summary if available
  if (conversationSummary) {
    systemPrompt += `\n\n---BEGIN CONTEXT SUMMARY---
The following is a summary of earlier parts of this conversation. This is NOT part of the current conversation - it's background context to help you understand what was discussed before. The actual recent messages will follow separately.

${conversationSummary}
---END CONTEXT SUMMARY---`;
  }

  // Build messages array with conversation history
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  // Add a marker if we have both a summary and recent messages
  if (conversationSummary && conversationHistory.length > 0) {
    messages.push({
      role: "user",
      content:
        "[SYSTEM NOTE: The following are the most recent messages from this conversation - these are verbatim, not summarized.]",
    });
  }

  // Add conversation history formatted as JSON to clearly separate metadata from content
  for (const msg of conversationHistory) {
    const contextEntry = {
      timestamp: formatTimestamp(msg.timestamp),
      role: msg.role,
      content: msg.content,
    };
    messages.push({
      role: msg.role,
      content: JSON.stringify(contextEntry),
    });
  }

  // Build the current message as JSON with context
  const currentTime = formatTimestamp(Date.now());
  const currentEntry: Record<string, string> = {
    timestamp: currentTime,
    role: "user",
    content: userMessage,
  };
  if (isAwaitingCheckin) {
    currentEntry.context =
      "The system just sent a daily check-in prompt asking the user to rate their day 1-5. This message is likely a check-in response.";
  }

  // Add current message
  messages.push({ role: "user", content: JSON.stringify(currentEntry) });

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 500,
    messages,
  });

  // Extract text from the response
  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No response from LLM");
  }

  try {
    // Try to extract JSON from the response (LLM sometimes wraps it in markdown)
    let jsonText = content.trim();

    // Remove markdown code blocks if present
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "");
    }

    // Try to find JSON object in the response
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonText = jsonMatch[0];
    }

    const intent = JSON.parse(jsonText) as Intent;
    return intent;
  } catch (error) {
    console.error("Failed to parse intent:", content, error);
    // If parsing fails, return a conversation intent with error handling
    return {
      type: "conversation",
      response:
        "Hmm, I didn't quite catch that. Could you say it another way? I can help with reminders, hold onto thoughts for you, or mark things done.",
    };
  }
}

export async function generateReminderMessage(
  taskContent: string,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const systemPrompt = `${TAMA_PERSONALITY}

Generate the initial reminder notification for a task. This is the first time you're nudging the user about this task at the time they requested. Keep it to 1-2 short sentences. Frame it as a soft nudge, not a command. Examples of tone: "Just a soft reminder about...", "This came up - ...", "Passing this along: ..."`;

  const taskPrompt = `Send a reminder about: "${taskContent}"`;

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 100,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Just a soft reminder about: ${taskContent}`;
  }

  return content;
}

export async function generateFinalNagMessage(
  taskContent: string,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const systemPrompt = `${TAMA_PERSONALITY}

Generate the final reminder message for a task. This is the last nudge - after this, you won't remind them again about this task. Keep it warm and pressure-free. Let them know it's okay and the task is still in their list whenever they're ready.`;

  const taskPrompt = `Send the final reminder about: "${taskContent}"`;

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 100,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Last gentle nudge about ${taskContent}. It's still in your list whenever you're ready.`;
  }

  return content;
}

export async function generateFollowUpMessage(
  taskContent: string,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const systemPrompt = `${TAMA_PERSONALITY}

Generate a very brief follow-up to a reminder you sent a few minutes ago. The user hasn't responded yet, so this is just a gentle "hey, still here" nudge. Keep it to one short sentence. Don't repeat the task details - just a soft check-in.`;

  const taskPrompt = `I sent a reminder about "${taskContent}" a few minutes ago but haven't heard back. Generate a brief follow-up.`;

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 100,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return "Just checking this reached you.";
  }

  return content;
}

export async function generateNaggingMessage(
  task: Task,
  naggingLevel: number,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  // Tama's gentle reminder styles - never escalating to pressure or urgency
  const reminderStyles: Record<number, string> = {
    0: "This is the first gentle nudge. Frame it as 'just passing this along' or 'in case now's a good time.'",
    1: "Second soft reminder. Maybe acknowledge it came up again. Offer to reschedule or drop it if needed.",
    2: "Third reminder. Stay gentle. You could mention you're still holding onto this for them.",
    3: "Fourth reminder. Remain calm and non-judgmental. Offer options: reschedule, break it down, or let it go.",
    4: "Final reminder. No pressure. Let them know this is the last nudge, and it's okay either way.",
  };

  const style = reminderStyles[Math.min(naggingLevel, 4)] || reminderStyles[4];

  const systemPrompt = `${TAMA_PERSONALITY}

Generate a soft reminder message for a task. ${style}

Keep it to 1-2 short sentences. Never use "You should..." or "Don't forget..." - instead use phrases like "Just a soft reminder..." or "This came up again, in case now's better." Never shame or pressure.`;

  const taskPrompt = `Remind me about: ${task.content}`;

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 150,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Just a soft reminder about: ${task.content}`;
  }

  return content;
}

export function calculateNextNagDelay(
  naggingLevel: number,
  isImportant: boolean,
): number {
  // Base delays in minutes, escalating
  const baseDelays = [60, 120, 240, 360, 480]; // 1hr, 2hr, 4hr, 6hr, 8hr

  // For important tasks, nag more frequently
  const multiplier = isImportant ? 0.5 : 1;

  const delay = baseDelays[Math.min(naggingLevel, baseDelays.length - 1)];
  return Math.round(delay * multiplier);
}

export async function generateCheckinPrompt(
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const systemPrompt = `${TAMA_PERSONALITY}

Generate a soft daily check-in. Ask the user to rate how their day felt on a scale of 1-5, with optional notes. Keep it to 1-2 sentences, warm and low-pressure. No exclamation points. Vary your wording to keep it fresh. Frame it as curiosity, not obligation.`;

  const taskPrompt = "Generate a daily check-in prompt.";

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 150,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return "Hey. Quick check-in if you want - on a scale of 1-5, how did today feel? Notes are optional.";
  }

  return content;
}

export async function generateEndOfDayMessage(
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const systemPrompt = `${TAMA_PERSONALITY}

Generate a gentle end-of-day message. Ask if there's anything the user wants to remember for tomorrow - a thought, a task, anything on their mind. Also wish them a good night. Keep it warm and cozy, like a soft send-off before sleep. Keep it to 2-3 sentences. Vary your wording to keep it fresh.`;

  const taskPrompt = "Generate an end-of-day message.";

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 150,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return "Hey, before you drift off - anything you want to remember for tomorrow? Sleep well.";
  }

  return content;
}

export async function generateWeeklyInsights(
  checkIns: CheckIn[],
  dumps: BrainDump[],
  completedTaskCount: number,
  context?: ConversationContext,
): Promise<string> {
  const client = getClient();

  const checkInsText =
    checkIns.length > 0
      ? checkIns
          .map((c) => {
            const dayName = new Date(c.date).toLocaleDateString("en-US", {
              weekday: "long",
            });
            const notesStr = c.notes ? ` - "${c.notes}"` : "";
            return `- ${dayName}: ${c.rating}/5${notesStr}`;
          })
          .join("\n")
      : "No check-ins this week.";

  const avgRating =
    checkIns.length > 0
      ? (
          checkIns.reduce((sum, c) => sum + c.rating, 0) / checkIns.length
        ).toFixed(1)
      : "N/A";

  const dumpsText =
    dumps.length > 0
      ? dumps.map((d) => `- ${d.content}`).join("\n")
      : "No brain dumps this week.";

  const systemPrompt = `${TAMA_PERSONALITY}

Create a gentle weekly reflection. Notice patterns (which days felt better/harder, any themes) without judgment. If you offer suggestions, frame them as options, not directives - "maybe," "you could try," "if it helps." Never imply the user should have done more. Treat all outcomes as neutral data. Keep it warm and concise.`;

  const taskPrompt = `Here's my week:

Daily check-ins (1-5 rating):
${checkInsText}

Average rating: ${avgRating}
Tasks completed: ${completedTaskCount}
Brain dumps captured: ${dumps.length}

${dumps.length > 0 ? `Brain dump topics:\n${dumpsText}` : ""}

Please share any patterns you notice, gently.`;

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 600,
    messages: buildContextMessages(systemPrompt, taskPrompt, context),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Weekly Summary\n\nCheck-ins: ${checkIns.length}/7 days\nAverage rating: ${avgRating}\nTasks completed: ${completedTaskCount}`;
  }

  return `Weekly Summary\n\n${content}`;
}

// Action types for generating dynamic responses
export type ActionContext =
  | {
      type: "reminder_created";
      task: string;
      timeStr: string;
      isImportant: boolean;
    }
  | {
      type: "multiple_reminders_created";
      reminders: { task: string; timeStr: string; isImportant: boolean }[];
    }
  | { type: "brain_dump_saved"; content: string }
  | { type: "task_completed"; task: string }
  | { type: "task_cancelled"; task: string }
  | { type: "multiple_tasks_cancelled"; tasks: string[] }
  | {
      type: "task_list";
      tasks: { content: string; timeStr: string; isImportant: boolean }[];
    }
  | { type: "no_tasks" }
  | { type: "task_not_found"; action: "done" | "cancel" }
  | { type: "checkin_logged"; rating: number; hasNotes: boolean }
  | { type: "checkin_time_set"; timeStr: string }
  | {
      type: "reminder_with_list_created";
      task: string;
      timeStr: string;
      listName: string;
      itemCount: number;
      isImportant: boolean;
    }
  | { type: "list_created"; name: string; itemCount: number }
  | {
      type: "lists_shown";
      lists: {
        name: string;
        itemCount: number;
        checkedCount: number;
        hasReminder: boolean;
      }[];
    }
  | {
      type: "list_shown";
      name: string;
      items: { content: string; isChecked: boolean }[];
      linkedTaskContent?: string;
      linkedTaskTimeStr?: string;
    }
  | { type: "no_lists" }
  | { type: "list_not_found" }
  | {
      type: "list_modified";
      name: string;
      action: string;
      items?: string[];
      newName?: string;
    }
  | { type: "list_deleted"; name: string }
  | { type: "task_completed_with_list"; task: string; listName: string };

export async function generateActionResponse(
  actionContext: ActionContext,
  conversationContext?: ConversationContext,
): Promise<string> {
  const client = getClient();

  let prompt: string;

  switch (actionContext.type) {
    case "reminder_created":
      prompt = `The user just set a reminder for "${actionContext.task}" in ${actionContext.timeStr}.${actionContext.isImportant ? " They marked it as important, so I'll nag them until it's done." : ""} Acknowledge this warmly and briefly.`;
      break;
    case "multiple_reminders_created":
      const reminderList = actionContext.reminders
        .map(
          (r) =>
            `- "${r.task}" in ${r.timeStr}${r.isImportant ? " (important)" : ""}`,
        )
        .join("\n");
      prompt = `The user just created ${actionContext.reminders.length} reminders:\n${reminderList}\nAcknowledge this briefly - confirm they're set.`;
      break;
    case "brain_dump_saved":
      prompt = `The user just captured a thought/brain dump: "${actionContext.content}". Acknowledge that it's been saved and they'll see it in their daily summary. Keep it very brief.`;
      break;
    case "task_completed":
      prompt = `The user just marked "${actionContext.task}" as done. Give them a calm, proportional acknowledgment.`;
      break;
    case "task_cancelled":
      prompt = `The user just cancelled the task "${actionContext.task}". Acknowledge neutrally.`;
      break;
    case "multiple_tasks_cancelled":
      const taskList = actionContext.tasks.map((t) => `- "${t}"`).join("\n");
      prompt = `The user just cancelled ${actionContext.tasks.length} tasks:\n${taskList}\nAcknowledge neutrally - it's okay to change priorities.`;
      break;
    case "task_list":
      const formattedTasks = actionContext.tasks
        .map(
          (t, i) =>
            `${i + 1}. ${t.content}${t.isImportant ? " (important)" : ""} - ${t.timeStr}`,
        )
        .join("\n");
      prompt = `Show the user their pending tasks in a clear format. Here are the tasks:\n${formattedTasks}\n\nPresent this list clearly. You can add a brief, warm intro or outro but keep it minimal.`;
      break;
    case "no_tasks":
      prompt = `The user has no pending tasks or reminders. Let them know in a warm way.`;
      break;
    case "task_not_found":
      prompt = `The user tried to mark a task as ${actionContext.action === "done" ? "done" : "cancelled"}, but I couldn't find a matching pending task. Gently let them know.`;
      break;
    case "checkin_logged":
      prompt = `The user just completed their daily check-in with a rating of ${actionContext.rating}/5.${actionContext.hasNotes ? " They also included some notes." : ""} Respond appropriately to their rating.`;
      break;
    case "checkin_time_set":
      prompt = `The user just set their daily check-in time to ${actionContext.timeStr}. They'll also get a daily summary and weekly summary on Sundays at this time. Confirm this briefly.`;
      break;
    case "reminder_with_list_created":
      prompt = `The user just set a reminder for "${actionContext.task}" in ${actionContext.timeStr}, with a linked list called "${actionContext.listName}" containing ${actionContext.itemCount} items.${actionContext.isImportant ? " They marked it as important." : ""} Acknowledge warmly - mention both the reminder and that you're keeping track of the list items.`;
      break;
    case "list_created":
      prompt = `The user just created a list called "${actionContext.name}" with ${actionContext.itemCount} items. Acknowledge briefly that the list is saved.`;
      break;
    case "lists_shown": {
      const listSummaries = actionContext.lists
        .map((l) => `- ${l.name} - ${l.itemCount}`)
        .join("\n");
      prompt = `Show the user their lists in this exact format (name - count):\n${listSummaries}\n\nJust add a brief intro, then list them exactly as shown above. Keep it minimal.`;
      break;
    }
    case "list_shown": {
      const itemsList = actionContext.items
        .map((i) => `- [${i.isChecked ? "x" : " "}] ${i.content}`)
        .join("\n");
      const reminderInfo = actionContext.linkedTaskContent
        ? `\nThis list is linked to a reminder: "${actionContext.linkedTaskContent}" (${actionContext.linkedTaskTimeStr})`
        : "";
      prompt = `Show the user their "${actionContext.name}" list:\n${itemsList}${reminderInfo}\n\nPresent this clearly.`;
      break;
    }
    case "no_lists":
      prompt = `The user has no lists yet. Let them know warmly.`;
      break;
    case "list_not_found":
      prompt = `The user tried to access a list but I couldn't find a matching one. Gently let them know.`;
      break;
    case "list_modified": {
      const itemsStr = actionContext.items?.join(", ") || "";
      if (actionContext.action === "add_items") {
        prompt = `Added ${itemsStr} to the "${actionContext.name}" list. Acknowledge briefly.`;
      } else if (actionContext.action === "remove_items") {
        prompt = `Removed ${itemsStr} from the "${actionContext.name}" list. Acknowledge briefly.`;
      } else if (actionContext.action === "check_items") {
        prompt = `Checked off ${itemsStr} from the "${actionContext.name}" list. Acknowledge briefly.`;
      } else if (actionContext.action === "uncheck_items") {
        prompt = `Unchecked ${itemsStr} from the "${actionContext.name}" list. Acknowledge briefly.`;
      } else if (actionContext.action === "rename") {
        prompt = `Renamed the list from "${actionContext.name}" to "${actionContext.newName}". Acknowledge briefly.`;
      } else {
        prompt = `Modified the "${actionContext.name}" list. Acknowledge briefly.`;
      }
      break;
    }
    case "list_deleted":
      prompt = `The user deleted the "${actionContext.name}" list. Acknowledge neutrally.`;
      break;
    case "task_completed_with_list":
      prompt = `The user just completed "${actionContext.task}" which had a linked list "${actionContext.listName}". Both the task and list are now done. Give a calm acknowledgment.`;
      break;
  }

  const systemPrompt = `${TAMA_PERSONALITY}

Generate a response to acknowledge an action. Keep it to 1-2 sentences max. Be warm but brief. For task lists, you may format with bullet points or numbers.`;

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 200,
    messages: buildContextMessages(systemPrompt, prompt, conversationContext),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    // Fallbacks for each type
    switch (actionContext.type) {
      case "reminder_created":
        return `Got it, I'll remind you about ${actionContext.task} in ${actionContext.timeStr}.`;
      case "multiple_reminders_created":
        return `Set ${actionContext.reminders.length} reminders for you.`;
      case "brain_dump_saved":
        return `Captured that thought.`;
      case "task_completed":
        return `Marked ${actionContext.task} as done.`;
      case "task_cancelled":
        return `Cancelled ${actionContext.task}.`;
      case "multiple_tasks_cancelled":
        return `Cancelled ${actionContext.tasks.length} tasks.`;
      case "task_list":
        return actionContext.tasks
          .map((t, i) => `${i + 1}. ${t.content} - ${t.timeStr}`)
          .join("\n");
      case "no_tasks":
        return `You have no pending tasks.`;
      case "task_not_found":
        return `Couldn't find a matching task. Say "list tasks" to see what's pending.`;
      case "checkin_logged":
        return `Logged your check-in: ${actionContext.rating}/5.`;
      case "checkin_time_set":
        return `Check-in time set to ${actionContext.timeStr}.`;
      case "reminder_with_list_created":
        return `Got it, I'll remind you about ${actionContext.task} in ${actionContext.timeStr}. Keeping track of ${actionContext.itemCount} items on your ${actionContext.listName} list.`;
      case "list_created":
        return `Created your ${actionContext.name} list with ${actionContext.itemCount} items.`;
      case "lists_shown":
        return actionContext.lists
          .map((l) => `- ${l.name} - ${l.itemCount}`)
          .join("\n");
      case "list_shown":
        return `${actionContext.name}:\n${actionContext.items.map((i) => `${i.isChecked ? "✓" : "○"} ${i.content}`).join("\n")}`;
      case "no_lists":
        return `You don't have any lists yet.`;
      case "list_not_found":
        return `Couldn't find that list. Say "show my lists" to see what's available.`;
      case "list_modified":
        return `Updated your ${actionContext.name} list.`;
      case "list_deleted":
        return `Deleted the ${actionContext.name} list.`;
      case "task_completed_with_list":
        return `Done with ${actionContext.task} and checked off the ${actionContext.listName} list.`;
    }
  }

  return content;
}

export async function generateConversationSummary(
  messages: {
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }[],
  existingSummary?: string,
): Promise<string> {
  const client = getClient();

  // Format messages for the summary prompt
  const formattedMessages = messages
    .map((m) => {
      const time = new Date(m.timestamp).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      return `[${time}] ${m.role === "user" ? "User" : "Tama"}: ${m.content}`;
    })
    .join("\n");

  const summaryContext = existingSummary
    ? `EXISTING CONTEXT SUMMARY (from earlier conversation):\n${existingSummary}\n\n---\n\nNEWER MESSAGES TO INCORPORATE (weight these more heavily as they are more recent):\n${formattedMessages}`
    : `MESSAGES TO SUMMARIZE:\n${formattedMessages}`;

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content: `You are summarizing a conversation between a user with ADHD and their support companion Tama. Create a concise summary that captures:

1. Key topics discussed
2. Any tasks, reminders, or commitments mentioned
3. Emotional context or state the user expressed
4. Any preferences or patterns noticed

Keep the summary factual and concise (2-4 sentences). This summary will be used as context for future conversations, so focus on information that would be helpful to remember.

${existingSummary ? "IMPORTANT: An existing summary from earlier in the conversation is provided. Incorporate that context but weight the newer messages more heavily since they contain more recent information. Create a unified summary that blends both." : ""}`,
      },
      {
        role: "user",
        content: summaryContext,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    // Fallback to a basic summary if LLM fails
    return existingSummary || "Previous conversation context unavailable.";
  }

  return content;
}
