import Anthropic from "@anthropic-ai/sdk";
import type { Intent, Task, BrainDump } from "./types.js";

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

const SYSTEM_PROMPT = `You are an ADHD support assistant integrated into a Telegram bot. Your job is to parse user messages and determine their intent.

You MUST respond with valid JSON only. No markdown, no explanation, just the JSON object.

Possible intents:
1. "reminder" - User wants to be reminded about something
   - Extract the task description and delay time
   - If they mention "important" or "nag me", set isImportant to true
   - Convert time expressions to minutes (e.g., "in 2 hours" = 120 minutes, "in 30 min" = 30 minutes)
   
2. "brain_dump" - User wants to quickly capture a thought/idea
   - Keywords: "dump", "note", "idea", "thought", "remember this", just random stream of consciousness
   - If the message seems like a random thought without a clear action, treat it as a brain dump
   
3. "mark_done" - User indicates they completed a task
   - Keywords: "done", "finished", "completed", "did it"
   - Include any task description they mention to help match it
   
4. "list_tasks" - User wants to see their pending tasks/reminders
   - Keywords: "list", "show", "what", "tasks", "reminders", "pending"
   
5. "conversation" - General chat or unclear intent
   - Provide a helpful, friendly response
   - If you can't determine the intent, ask clarifying questions

Response formats:
- reminder: {"type": "reminder", "task": "description", "delayMinutes": number, "isImportant": boolean}
- brain_dump: {"type": "brain_dump", "content": "the captured thought/idea"}
- mark_done: {"type": "mark_done", "taskDescription": "optional description to match"}
- list_tasks: {"type": "list_tasks"}
- conversation: {"type": "conversation", "response": "your message to the user"}

Be lenient and helpful. ADHD users may send fragmented or unclear messages - try to understand their intent.`;

export async function parseIntent(userMessage: string): Promise<Intent> {
  const client = getClient();

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  });

  // Extract text from the response
  const textContent = message.content.find((block) => block.type === "text");
  if (!textContent || textContent.type !== "text") {
    throw new Error("No text response from Claude");
  }

  try {
    // Try to extract JSON from the response (Claude sometimes wraps it in markdown)
    let jsonText = textContent.text.trim();
    
    // Remove markdown code blocks if present
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    
    // Try to find JSON object in the response
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonText = jsonMatch[0];
    }
    
    const intent = JSON.parse(jsonText) as Intent;
    return intent;
  } catch (error) {
    console.error("Failed to parse intent:", textContent.text, error);
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
  naggingLevel: number
): Promise<string> {
  const client = getClient();

  const urgencyPrompts: Record<number, string> = {
    0: "Be gentle and friendly. First reminder.",
    1: "Slightly more insistent but still friendly. Second reminder.",
    2: "More urgent tone. Third reminder - emphasize importance.",
    3: "Quite urgent now. Fourth reminder - express concern.",
    4: "Very urgent. Final warnings - this really needs to get done.",
  };

  const urgency = urgencyPrompts[Math.min(naggingLevel, 4)] || urgencyPrompts[4];

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    system: `You are an ADHD support assistant. Generate a short, motivating reminder message for a task. ${urgency} Keep it under 2 sentences. Be supportive, not annoying. Don't use emojis excessively.`,
    messages: [
      {
        role: "user",
        content: `Remind me about: ${task.content}`,
      },
    ],
  });

  const textContent = message.content.find((block) => block.type === "text");
  if (!textContent || textContent.type !== "text") {
    return `Reminder: ${task.content}`;
  }

  return textContent.text;
}

export async function generateDailySummary(
  dumps: BrainDump[],
  pendingTasks: Task[]
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

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: `You are an ADHD support assistant. Create a friendly, organized daily summary. Be encouraging and help the user see patterns or connections in their thoughts. Keep it concise but insightful.`,
    messages: [
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

  const textContent = message.content.find((block) => block.type === "text");
  if (!textContent || textContent.type !== "text") {
    return `📋 Daily Summary\n\nBrain dumps: ${dumps.length}\nPending tasks: ${pendingTasks.length}`;
  }

  return `📋 Daily Summary\n\n${textContent.text}`;
}

export function calculateNextNagDelay(
  naggingLevel: number,
  isImportant: boolean
): number {
  // Base delays in minutes, escalating
  const baseDelays = [60, 120, 240, 360, 480]; // 1hr, 2hr, 4hr, 6hr, 8hr

  // For important tasks, nag more frequently
  const multiplier = isImportant ? 0.5 : 1;

  const delay = baseDelays[Math.min(naggingLevel, baseDelays.length - 1)];
  return Math.round(delay * multiplier);
}

