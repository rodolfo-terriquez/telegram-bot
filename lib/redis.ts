import { Redis } from "@upstash/redis";
import type { Task, BrainDump } from "./types.js";

let redisClient: Redis | null = null;

function getClient(): Redis {
  if (!redisClient) {
    redisClient = Redis.fromEnv();
  }
  return redisClient;
}

// Key patterns
const TASK_KEY = (chatId: number, taskId: string) => `task:${chatId}:${taskId}`;
const TASKS_SET_KEY = (chatId: number) => `tasks:${chatId}`;
const DUMP_KEY = (chatId: number, dumpId: string) => `dump:${chatId}:${dumpId}`;
const DUMPS_SET_KEY = (chatId: number, date: string) => `dumps:${chatId}:${date}`;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function getTodayKey(): string {
  return new Date().toISOString().split("T")[0];
}

// Task operations
export async function createTask(
  chatId: number,
  content: string,
  isImportant: boolean,
  delayMinutes: number
): Promise<Task> {
  const redis = getClient();
  const id = generateId();
  const now = Date.now();

  const task: Task = {
    id,
    chatId,
    content,
    isImportant,
    naggingLevel: 0,
    nextReminder: now + delayMinutes * 60 * 1000,
    createdAt: now,
    status: "pending",
  };

  await redis.set(TASK_KEY(chatId, id), JSON.stringify(task));
  await redis.sadd(TASKS_SET_KEY(chatId), id);

  return task;
}

export async function getTask(
  chatId: number,
  taskId: string
): Promise<Task | null> {
  const redis = getClient();
  const data = await redis.get<string>(TASK_KEY(chatId, taskId));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function updateTask(task: Task): Promise<void> {
  const redis = getClient();
  await redis.set(TASK_KEY(task.chatId, task.id), JSON.stringify(task));
}

export async function completeTask(
  chatId: number,
  taskId: string
): Promise<Task | null> {
  const task = await getTask(chatId, taskId);
  if (!task) return null;

  task.status = "completed";
  await updateTask(task);
  await getClient().srem(TASKS_SET_KEY(chatId), taskId);

  return task;
}

export async function getPendingTasks(chatId: number): Promise<Task[]> {
  const redis = getClient();
  const taskIds = await redis.smembers<string[]>(TASKS_SET_KEY(chatId));

  if (!taskIds || taskIds.length === 0) return [];

  const tasks: Task[] = [];
  for (const taskId of taskIds) {
    const task = await getTask(chatId, taskId);
    if (task && task.status === "pending") {
      tasks.push(task);
    }
  }

  return tasks.sort((a, b) => a.nextReminder - b.nextReminder);
}

export async function findTaskByDescription(
  chatId: number,
  description?: string
): Promise<Task | null> {
  const tasks = await getPendingTasks(chatId);
  if (tasks.length === 0) return null;

  // If no description, return the most recent task
  if (!description) {
    return tasks[tasks.length - 1];
  }

  // Try to find a matching task (fuzzy match)
  const normalizedDesc = description.toLowerCase();
  const matchedTask = tasks.find((t) =>
    t.content.toLowerCase().includes(normalizedDesc) ||
    normalizedDesc.includes(t.content.toLowerCase())
  );

  return matchedTask || tasks[tasks.length - 1];
}

// Brain dump operations
export async function createBrainDump(
  chatId: number,
  content: string
): Promise<BrainDump> {
  const redis = getClient();
  const id = generateId();
  const now = Date.now();
  const todayKey = getTodayKey();

  const dump: BrainDump = {
    id,
    chatId,
    content,
    createdAt: now,
  };

  await redis.set(DUMP_KEY(chatId, id), JSON.stringify(dump));
  await redis.sadd(DUMPS_SET_KEY(chatId, todayKey), id);
  // Set expiration for dumps (30 days)
  await redis.expire(DUMP_KEY(chatId, id), 30 * 24 * 60 * 60);

  return dump;
}

export async function getTodaysDumps(chatId: number): Promise<BrainDump[]> {
  const redis = getClient();
  const todayKey = getTodayKey();
  const dumpIds = await redis.smembers<string[]>(DUMPS_SET_KEY(chatId, todayKey));

  if (!dumpIds || dumpIds.length === 0) return [];

  const dumps: BrainDump[] = [];
  for (const dumpId of dumpIds) {
    const data = await redis.get<string>(DUMP_KEY(chatId, dumpId));
    if (data) {
      const dump = typeof data === "string" ? JSON.parse(data) : data;
      dumps.push(dump);
    }
  }

  return dumps.sort((a, b) => a.createdAt - b.createdAt);
}

// Chat IDs for daily summary (store all active chats)
const ACTIVE_CHATS_KEY = "active_chats";

export async function registerChat(chatId: number): Promise<void> {
  const redis = getClient();
  await redis.sadd(ACTIVE_CHATS_KEY, chatId.toString());
}

export async function getActiveChats(): Promise<number[]> {
  const redis = getClient();
  const chatIds = await redis.smembers<string[]>(ACTIVE_CHATS_KEY);
  return (chatIds || []).map((id) => parseInt(id, 10));
}

// Conversation memory
const CONVERSATION_KEY = (chatId: number) => `conversation:${chatId}`;
const MAX_CONVERSATION_LENGTH = 10; // Keep last 10 message pairs
const CONVERSATION_TTL = 24 * 60 * 60; // 24 hours

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export async function getConversationHistory(
  chatId: number
): Promise<ConversationMessage[]> {
  const redis = getClient();
  const key = CONVERSATION_KEY(chatId);
  const data = await redis.get<string>(key);
  
  if (!data) return [];
  
  try {
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    return [];
  }
}

export async function addToConversation(
  chatId: number,
  userMessage: string,
  assistantResponse: string
): Promise<void> {
  const redis = getClient();
  const key = CONVERSATION_KEY(chatId);
  
  // Get existing conversation
  const history = await getConversationHistory(chatId);
  
  // Add new messages
  const now = Date.now();
  history.push(
    { role: "user", content: userMessage, timestamp: now },
    { role: "assistant", content: assistantResponse, timestamp: now }
  );
  
  // Keep only the last N message pairs (N*2 messages)
  const trimmed = history.slice(-(MAX_CONVERSATION_LENGTH * 2));
  
  // Save with TTL
  await redis.set(key, JSON.stringify(trimmed), { ex: CONVERSATION_TTL });
}

export async function clearConversation(chatId: number): Promise<void> {
  const redis = getClient();
  await redis.del(CONVERSATION_KEY(chatId));
}

