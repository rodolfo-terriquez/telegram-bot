import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Intent, Task, BrainDump, CheckIn } from "./types.js";
import type { ConversationMessage } from "./redis.js";

let openrouterClient: OpenAI | null = null;

// Model to use - configurable via environment variable
function getModel(): string {
  return process.env.OPENROUTER_MODEL || "x-ai/grok-3-fast";
}

function getClient(): OpenAI {
  if (!openrouterClient) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set");
    }
    openrouterClient = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey,
      defaultHeaders: {
        "HTTP-Referer": process.env.BASE_URL || "https://telegram-bot.vercel.app",
        "X-Title": "ADHD Support Bot",
      },
    });
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

// Base system prompt - timestamp will be prepended dynamically
const BASE_SYSTEM_PROMPT = `You are an ADHD support assistant integrated into a Telegram bot. Your job is to parse user messages and determine their intent.

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
   - If they mention "important" or "nag me", set isImportant to true
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

10. "conversation" - General chat or unclear intent
   - Provide a helpful, friendly response
   - If you can't determine the intent, ask clarifying questions

Response formats:
- reminder: {"type": "reminder", "task": "description", "delayMinutes": number, "isImportant": boolean}
- multiple_reminders: {"type": "multiple_reminders", "reminders": [{"task": "description", "delayMinutes": number, "isImportant": boolean}, ...]}
- brain_dump: {"type": "brain_dump", "content": "the captured thought/idea"}
- mark_done: {"type": "mark_done", "taskDescription": "optional description to match"}
- cancel_task: {"type": "cancel_task", "taskDescription": "optional description to match"}
- cancel_multiple_tasks: {"type": "cancel_multiple_tasks", "taskDescriptions": ["description1", "description2", ...]}
- list_tasks: {"type": "list_tasks"}
- checkin_response: {"type": "checkin_response", "rating": number, "notes": "optional notes"}
- set_checkin_time: {"type": "set_checkin_time", "hour": number, "minute": number}
- conversation: {"type": "conversation", "response": "your message to the user"}

Be lenient and helpful. ADHD users may send fragmented or unclear messages - try to understand their intent.`;

export async function parseIntent(
  userMessage: string,
  conversationHistory: ConversationMessage[] = [],
  isAwaitingCheckin: boolean = false,
): Promise<Intent> {
  const client = getClient();

  // Build system prompt with current timestamp
  const systemPrompt = getCurrentTimeContext() + BASE_SYSTEM_PROMPT;

  // Build messages array with conversation history
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  // Add conversation history with context markers and timestamps
  for (const msg of conversationHistory) {
    const timeStr = formatTimestamp(msg.timestamp);
    if (msg.role === "user") {
      messages.push({ role: "user", content: `[${timeStr}] ${msg.content}` });
    } else {
      // Wrap assistant messages to indicate they were user-facing responses
      messages.push({
        role: "assistant",
        content: `[${timeStr}] [I responded to the user with: "${msg.content}"]`,
      });
    }
  }

  // Build the current message with context and timestamp
  const currentTime = formatTimestamp(Date.now());
  let contextualMessage = `[${currentTime}] ${userMessage}`;
  if (isAwaitingCheckin) {
    contextualMessage = `[CONTEXT: The system just sent a daily check-in prompt asking the user to rate their day 1-5. This message is likely a check-in response.]\n\n[${currentTime}] ${userMessage}`;
  }

  // Add current message
  messages.push({ role: "user", content: contextualMessage });

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
        "I had trouble understanding that. Could you rephrase? You can ask me to remind you about something, capture a quick thought, or mark tasks as done.",
    };
  }
}

export async function generateNaggingMessage(
  task: Task,
  naggingLevel: number,
): Promise<string> {
  const client = getClient();

  const urgencyPrompts: Record<number, string> = {
    0: "Be gentle and friendly. First reminder.",
    1: "Slightly more insistent but still friendly. Second reminder.",
    2: "More urgent tone. Third reminder - emphasize importance.",
    3: "Quite urgent now. Fourth reminder - express concern.",
    4: "Very urgent. Final warnings - this really needs to get done.",
  };

  const urgency =
    urgencyPrompts[Math.min(naggingLevel, 4)] || urgencyPrompts[4];

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 150,
    messages: [
      {
        role: "system",
        content: `You are an ADHD support assistant. Generate a short, motivating reminder message for a task. ${urgency} Keep it under 2 sentences. Be supportive, not annoying. Don't use emojis excessively.`,
      },
      {
        role: "user",
        content: `Remind me about: ${task.content}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `Reminder: ${task.content}`;
  }

  return content;
}

export async function generateDailySummary(
  dumps: BrainDump[],
  pendingTasks: Task[],
): Promise<string> {
  const client = getClient();

  const dumpsText =
    dumps.length > 0
      ? dumps.map((d) => `- ${d.content}`).join("\n")
      : "No brain dumps today.";

  const tasksText =
    pendingTasks.length > 0
      ? pendingTasks.map((t) => `- ${t.content}`).join("\n")
      : "No pending tasks.";

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content: `You are an ADHD support assistant. Create a friendly, organized daily summary. Be encouraging and help the user see patterns or connections in their thoughts. Keep it concise but insightful.`,
      },
      {
        role: "user",
        content: `Here's my daily summary:

Brain dumps captured today:
${dumpsText}

Pending tasks/reminders:
${tasksText}

Please summarize this in a helpful, encouraging way.`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `📋 Daily Summary\n\nBrain dumps: ${dumps.length}\nPending tasks: ${pendingTasks.length}`;
  }

  return `📋 Daily Summary\n\n${content}`;
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

export async function generateCheckinPrompt(): Promise<string> {
  const client = getClient();

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 150,
    messages: [
      {
        role: "system",
        content: `You are an ADHD support assistant. Generate a friendly, brief daily check-in question asking the user to rate how organized they felt today on a scale of 1-5. Encourage them to add notes if they want. Keep it warm and casual, under 2 sentences. Vary your wording to keep it fresh.`,
      },
      {
        role: "user",
        content: "Generate a daily check-in prompt.",
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return "Hey! Quick check-in: On a scale of 1-5, how organized did you feel today? Feel free to add any notes!";
  }

  return content;
}

export async function generateWeeklyInsights(
  checkIns: CheckIn[],
  dumps: BrainDump[],
  completedTaskCount: number,
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

  const response = await client.chat.completions.create({
    model: getModel(),
    max_tokens: 600,
    messages: [
      {
        role: "system",
        content: `You are an ADHD support assistant. Create an insightful weekly summary based on the user's daily check-ins. Look for patterns (e.g., which days were better/worse, any themes in their notes). Offer one or two gentle, actionable suggestions. Be encouraging and supportive. Keep it concise but meaningful.`,
      },
      {
        role: "user",
        content: `Here's my week:

Daily check-ins (1-5 organization rating):
${checkInsText}

Average rating: ${avgRating}
Tasks completed: ${completedTaskCount}
Brain dumps captured: ${dumps.length}

${dumps.length > 0 ? `Brain dump topics:\n${dumpsText}` : ""}

Please provide insights and patterns you notice.`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return `📊 Weekly Summary\n\nCheck-ins: ${checkIns.length}/7 days\nAverage rating: ${avgRating}\nTasks completed: ${completedTaskCount}`;
  }

  return `📊 Weekly Summary\n\n${content}`;
}

