import { Redis } from "@upstash/redis";
import type { Task, BrainDump, CheckIn, UserPreferences } from "./types.js";

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
const DUMPS_SET_KEY = (chatId: number, date: string) =>
  `dumps:${chatId}:${date}`;
const CHECKIN_KEY = (chatId: number, date: string) =>
  `checkin:${chatId}:${date}`;
const CHECKINS_SET_KEY = (chatId: number) => `checkins:${chatId}`;
const USER_PREFS_KEY = (chatId: number) => `user_prefs:${chatId}`;
const AWAITING_CHECKIN_KEY = (chatId: number) => `awaiting_checkin:${chatId}`;
const COMPLETED_TASKS_KEY = (chatId: number, date: string) =>
  `completed:${chatId}:${date}`;

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
  delayMinutes: number,
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
  taskId: string,
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
  taskId: string,
): Promise<Task | null> {
  const redis = getClient();
  const task = await getTask(chatId, taskId);
  if (!task) return null;

  task.status = "completed";
  await updateTask(task);
  await redis.srem(TASKS_SET_KEY(chatId), taskId);

  // Track completion count for the day
  const todayKey = getTodayKey();
  const completedKey = COMPLETED_TASKS_KEY(chatId, todayKey);
  await redis.incr(completedKey);
  // Set expiration for 8 days (enough for weekly summary)
  await redis.expire(completedKey, 8 * 24 * 60 * 60);

  return task;
}

export async function deleteTask(
  chatId: number,
  taskId: string,
): Promise<Task | null> {
  const redis = getClient();
  const task = await getTask(chatId, taskId);
  if (!task) return null;

  // Remove from pending tasks set
  await redis.srem(TASKS_SET_KEY(chatId), taskId);
  // Delete the task data
  await redis.del(TASK_KEY(chatId, taskId));

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
  description?: string,
): Promise<Task | null> {
  const tasks = await getPendingTasks(chatId);
  if (tasks.length === 0) return null;

  // If no description, return the most recent task
  if (!description) {
    return tasks[tasks.length - 1];
  }

  // Try to find a matching task (fuzzy match)
  const normalizedDesc = description.toLowerCase();
  const matchedTask = tasks.find(
    (t) =>
      t.content.toLowerCase().includes(normalizedDesc) ||
      normalizedDesc.includes(t.content.toLowerCase()),
  );

  return matchedTask || tasks[tasks.length - 1];
}

// Brain dump operations
export async function createBrainDump(
  chatId: number,
  content: string,
): Promise<BrainDump> {
  const redis = getClient();
  const id = generateId();
  const now = Date.now();
  const todayKey = getTodayKey();
  const TTL_30_DAYS = 30 * 24 * 60 * 60;

  const dump: BrainDump = {
    id,
    chatId,
    content,
    createdAt: now,
  };

  await redis.set(DUMP_KEY(chatId, id), JSON.stringify(dump));
  await redis.sadd(DUMPS_SET_KEY(chatId, todayKey), id);
  // Set expiration for dumps and their index set (30 days)
  await redis.expire(DUMP_KEY(chatId, id), TTL_30_DAYS);
  await redis.expire(DUMPS_SET_KEY(chatId, todayKey), TTL_30_DAYS);

  return dump;
}

export async function getTodaysDumps(chatId: number): Promise<BrainDump[]> {
  return getDumpsByDate(chatId, getTodayKey());
}

export async function getDumpsByDate(
  chatId: number,
  dateKey: string,
): Promise<BrainDump[]> {
  const redis = getClient();
  const dumpIds = await redis.smembers<string[]>(
    DUMPS_SET_KEY(chatId, dateKey),
  );

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

export async function getWeeklyDumps(chatId: number): Promise<BrainDump[]> {
  const dumps: BrainDump[] = [];
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateKey = date.toISOString().split("T")[0];
    const dayDumps = await getDumpsByDate(chatId, dateKey);
    dumps.push(...dayDumps);
  }

  return dumps.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getWeeklyCompletedTaskCount(
  chatId: number,
): Promise<number> {
  const redis = getClient();
  const today = new Date();
  let total = 0;

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateKey = date.toISOString().split("T")[0];
    const count = await redis.get<number>(COMPLETED_TASKS_KEY(chatId, dateKey));
    if (count) {
      total +=
        typeof count === "number" ? count : parseInt(count as string, 10) || 0;
    }
  }

  return total;
}

// Chat IDs for daily summary (store all active chats)
const ACTIVE_CHATS_KEY = "active_chats";

export async function registerChat(chatId: number): Promise<boolean> {
  const redis = getClient();
  // sadd returns the number of elements added (1 if new, 0 if already exists)
  const added = await redis.sadd(ACTIVE_CHATS_KEY, chatId.toString());
  return added === 1;
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
  chatId: number,
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
  assistantResponse: string,
): Promise<void> {
  const redis = getClient();
  const key = CONVERSATION_KEY(chatId);

  // Get existing conversation
  const history = await getConversationHistory(chatId);

  // Add new messages
  const now = Date.now();
  history.push(
    { role: "user", content: userMessage, timestamp: now },
    { role: "assistant", content: assistantResponse, timestamp: now },
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

// Check-in operations
export async function saveCheckIn(
  chatId: number,
  rating: number,
  notes?: string,
): Promise<CheckIn> {
  const redis = getClient();
  const id = generateId();
  const now = Date.now();
  const todayKey = getTodayKey();
  const TTL_90_DAYS = 90 * 24 * 60 * 60;

  const checkIn: CheckIn = {
    id,
    chatId,
    date: todayKey,
    rating,
    notes,
    createdAt: now,
  };

  await redis.set(CHECKIN_KEY(chatId, todayKey), JSON.stringify(checkIn));
  await redis.sadd(CHECKINS_SET_KEY(chatId), todayKey);
  // Set expiration for check-ins and the index set (90 days)
  await redis.expire(CHECKIN_KEY(chatId, todayKey), TTL_90_DAYS);
  await redis.expire(CHECKINS_SET_KEY(chatId), TTL_90_DAYS);

  return checkIn;
}

export async function getCheckIn(
  chatId: number,
  date: string,
): Promise<CheckIn | null> {
  const redis = getClient();
  const data = await redis.get<string>(CHECKIN_KEY(chatId, date));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function getWeeklyCheckIns(chatId: number): Promise<CheckIn[]> {
  const checkIns: CheckIn[] = [];
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateKey = date.toISOString().split("T")[0];
    const checkIn = await getCheckIn(chatId, dateKey);
    if (checkIn) {
      checkIns.push(checkIn);
    }
  }

  return checkIns.sort((a, b) => a.createdAt - b.createdAt);
}

// User preferences operations
export async function getUserPreferences(
  chatId: number,
): Promise<UserPreferences | null> {
  const redis = getClient();
  const data = await redis.get<string>(USER_PREFS_KEY(chatId));
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function saveUserPreferences(
  prefs: UserPreferences,
): Promise<void> {
  const redis = getClient();
  await redis.set(USER_PREFS_KEY(prefs.chatId), JSON.stringify(prefs));
}

export async function setCheckinTime(
  chatId: number,
  hour: number,
  minute: number,
  scheduleId?: string,
): Promise<UserPreferences> {
  const existing = await getUserPreferences(chatId);
  const prefs: UserPreferences = {
    chatId,
    checkinTime: `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`,
    checkinScheduleId: scheduleId || existing?.checkinScheduleId,
    weeklySummaryScheduleId: existing?.weeklySummaryScheduleId,
  };
  await saveUserPreferences(prefs);
  return prefs;
}

// Awaiting check-in state
const AWAITING_CHECKIN_TTL = 60 * 60; // 1 hour

export async function markAwaitingCheckin(chatId: number): Promise<void> {
  const redis = getClient();
  await redis.set(AWAITING_CHECKIN_KEY(chatId), "1", {
    ex: AWAITING_CHECKIN_TTL,
  });
}

export async function isAwaitingCheckin(chatId: number): Promise<boolean> {
  const redis = getClient();
  const value = await redis.get(AWAITING_CHECKIN_KEY(chatId));
  return value === 1 || value === "1";
}

export async function clearAwaitingCheckin(chatId: number): Promise<void> {
  const redis = getClient();
  await redis.del(AWAITING_CHECKIN_KEY(chatId));
}
