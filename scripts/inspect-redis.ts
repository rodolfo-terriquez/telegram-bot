/**
 * Redis Inspection Script
 * Run with: npx ts-node scripts/inspect-redis.ts
 * Or: npx tsx scripts/inspect-redis.ts
 *
 * Make sure UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set in .env
 */

import { Redis } from "@upstash/redis";
import * as dotenv from "dotenv";

dotenv.config();

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

interface Task {
  id: string;
  chatId: number;
  content: string;
  isImportant: boolean;
  isDayOnly?: boolean;
  naggingLevel: number;
  nextReminder: number;
  qstashMessageId?: string;
  linkedListId?: string;
  createdAt: number;
  status: string;
}

interface List {
  id: string;
  chatId: number;
  name: string;
  items: { id: string; content: string; isChecked: boolean; createdAt: number }[];
  linkedTaskId?: string;
  createdAt: number;
  updatedAt: number;
  status: string;
}

async function inspectRedis() {
  console.log("🔍 Inspecting Redis database...\n");

  // Get all keys
  let cursor = 0;
  const allKeys: string[] = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, { count: 100 });
    cursor = Number(nextCursor);
    allKeys.push(...keys);
  } while (cursor !== 0);

  console.log(`Found ${allKeys.length} total keys\n`);

  // Group keys by type
  const keyGroups: Record<string, string[]> = {};
  for (const key of allKeys) {
    const prefix = key.split(":")[0];
    if (!keyGroups[prefix]) keyGroups[prefix] = [];
    keyGroups[prefix].push(key);
  }

  console.log("📊 Keys by type:");
  for (const [prefix, keys] of Object.entries(keyGroups).sort()) {
    console.log(`  ${prefix}: ${keys.length} keys`);
  }
  console.log("");

  // Inspect tasks
  const taskKeys = allKeys.filter(k => k.startsWith("task:") && k.split(":").length === 3);
  const tasksSetKeys = allKeys.filter(k => k.startsWith("tasks:"));

  console.log("═══════════════════════════════════════");
  console.log("📋 TASKS");
  console.log("═══════════════════════════════════════\n");

  const tasks: Task[] = [];
  const orphanedTaskKeys: string[] = [];

  for (const key of taskKeys) {
    const task = await redis.get(key) as Task | null;
    if (task) {
      tasks.push(task);
    }
  }

  // Check task set membership
  for (const setKey of tasksSetKeys) {
    const chatId = setKey.split(":")[1];
    const taskIds = await redis.smembers(setKey) as string[];

    console.log(`Chat ${chatId} has ${taskIds.length} task IDs in set`);

    for (const taskId of taskIds) {
      const taskKey = `task:${chatId}:${taskId}`;
      const exists = allKeys.includes(taskKey);
      if (!exists) {
        console.log(`  ⚠️  Task ID ${taskId} in set but no task data found`);
        orphanedTaskKeys.push(taskId);
      }
    }
  }

  console.log(`\nTotal tasks found: ${tasks.length}\n`);

  const now = Date.now();
  const timezone = process.env.USER_TIMEZONE || "America/Los_Angeles";

  for (const task of tasks.sort((a, b) => a.nextReminder - b.nextReminder)) {
    const reminderDate = new Date(task.nextReminder);
    const createdDate = new Date(task.createdAt);
    const isOverdue = task.nextReminder < now;
    const isPending = task.status === "pending";

    const reminderStr = reminderDate.toLocaleString("en-US", { timeZone: timezone });
    const createdStr = createdDate.toLocaleString("en-US", { timeZone: timezone });

    console.log(`Task: "${task.content}"`);
    console.log(`  ID: ${task.id}`);
    console.log(`  Status: ${task.status}${isOverdue && isPending ? " ⚠️ OVERDUE" : ""}`);
    console.log(`  Created: ${createdStr}`);
    console.log(`  Reminder: ${reminderStr}`);
    console.log(`  isDayOnly: ${task.isDayOnly ?? "not set"}`);
    console.log(`  isImportant: ${task.isImportant}`);
    if (task.qstashMessageId) console.log(`  QStash ID: ${task.qstashMessageId}`);
    if (task.linkedListId) console.log(`  Linked List: ${task.linkedListId}`);
    console.log("");
  }

  // Inspect lists
  const listKeys = allKeys.filter(k => k.startsWith("list:") && k.split(":").length === 3);
  const listsSetKeys = allKeys.filter(k => k.startsWith("lists:"));

  console.log("═══════════════════════════════════════");
  console.log("📝 LISTS");
  console.log("═══════════════════════════════════════\n");

  const lists: List[] = [];

  for (const key of listKeys) {
    const list = await redis.get(key) as List | null;
    if (list) {
      lists.push(list);
    }
  }

  // Check list set membership
  for (const setKey of listsSetKeys) {
    const chatId = setKey.split(":")[1];
    const listIds = await redis.smembers(setKey) as string[];

    console.log(`Chat ${chatId} has ${listIds.length} list IDs in set`);

    for (const listId of listIds) {
      const listKey = `list:${chatId}:${listId}`;
      const exists = allKeys.includes(listKey);
      if (!exists) {
        console.log(`  ⚠️  List ID ${listId} in set but no list data found`);
      }
    }
  }

  console.log(`\nTotal lists found: ${lists.length}\n`);

  for (const list of lists.sort((a, b) => a.name.localeCompare(b.name))) {
    const createdDate = new Date(list.createdAt);
    const updatedDate = new Date(list.updatedAt);
    const createdStr = createdDate.toLocaleString("en-US", { timeZone: timezone });
    const updatedStr = updatedDate.toLocaleString("en-US", { timeZone: timezone });

    console.log(`List: "${list.name}"`);
    console.log(`  ID: ${list.id}`);
    console.log(`  Status: ${list.status}`);
    console.log(`  Created: ${createdStr}`);
    console.log(`  Updated: ${updatedStr}`);
    console.log(`  Items (${list.items.length}):`);
    for (const item of list.items) {
      console.log(`    ${item.isChecked ? "☑" : "☐"} ${item.content}`);
    }
    if (list.linkedTaskId) {
      const linkedTask = tasks.find(t => t.id === list.linkedTaskId);
      if (linkedTask) {
        console.log(`  Linked Task: "${linkedTask.content}"`);
      } else {
        console.log(`  ⚠️  Linked Task ID ${list.linkedTaskId} NOT FOUND`);
      }
    }
    console.log("");
  }

  // Cross-reference tasks and lists
  console.log("═══════════════════════════════════════");
  console.log("🔗 CROSS-REFERENCES");
  console.log("═══════════════════════════════════════\n");

  let issues = 0;

  for (const task of tasks) {
    if (task.linkedListId) {
      const linkedList = lists.find(l => l.id === task.linkedListId);
      if (!linkedList) {
        console.log(`⚠️  Task "${task.content}" linked to non-existent list ${task.linkedListId}`);
        issues++;
      }
    }
  }

  for (const list of lists) {
    if (list.linkedTaskId) {
      const linkedTask = tasks.find(t => t.id === list.linkedTaskId);
      if (!linkedTask) {
        console.log(`⚠️  List "${list.name}" linked to non-existent task ${list.linkedTaskId}`);
        issues++;
      }
    }
  }

  if (issues === 0) {
    console.log("✅ No cross-reference issues found\n");
  } else {
    console.log(`\n⚠️  Found ${issues} cross-reference issues\n`);
  }

  // Inspect other data
  console.log("═══════════════════════════════════════");
  console.log("📦 OTHER DATA");
  console.log("═══════════════════════════════════════\n");

  // User preferences
  const prefsKeys = allKeys.filter(k => k.startsWith("user_prefs:"));
  for (const key of prefsKeys) {
    const prefs = await redis.get(key);
    console.log(`User Preferences (${key}):`);
    console.log(`  ${JSON.stringify(prefs, null, 2)}`);
    console.log("");
  }

  // Conversation data
  const convKeys = allKeys.filter(k => k.startsWith("conversation:"));
  for (const key of convKeys) {
    const conv = await redis.get(key) as { messages?: unknown[]; summary?: string } | null;
    if (conv) {
      console.log(`Conversation (${key}):`);
      console.log(`  Messages: ${conv.messages?.length ?? 0}`);
      console.log(`  Has summary: ${!!conv.summary}`);
      console.log("");
    }
  }

  // Check-ins
  const checkinKeys = allKeys.filter(k => k.startsWith("checkin:") && !k.startsWith("checkins:"));
  if (checkinKeys.length > 0) {
    console.log(`Check-ins: ${checkinKeys.length}`);
    for (const key of checkinKeys.slice(-5)) {
      const checkin = await redis.get(key);
      console.log(`  ${key}: ${JSON.stringify(checkin)}`);
    }
    console.log("");
  }

  // Brain dumps
  const dumpKeys = allKeys.filter(k => k.startsWith("dump:") && !k.startsWith("dumps:"));
  if (dumpKeys.length > 0) {
    console.log(`Brain dumps: ${dumpKeys.length}`);
    for (const key of dumpKeys.slice(-5)) {
      const dump = await redis.get(key);
      console.log(`  ${key}: ${JSON.stringify(dump)}`);
    }
    console.log("");
  }

  // Pending states
  const awaitingKeys = allKeys.filter(k => k.startsWith("awaiting_checkin:"));
  const pendingFollowUpKeys = allKeys.filter(k => k.startsWith("pending_follow_up:"));

  if (awaitingKeys.length > 0) {
    console.log(`Awaiting check-in: ${awaitingKeys.length}`);
    for (const key of awaitingKeys) {
      const val = await redis.get(key);
      console.log(`  ${key}: ${val}`);
    }
    console.log("");
  }

  if (pendingFollowUpKeys.length > 0) {
    console.log(`Pending follow-ups: ${pendingFollowUpKeys.length}`);
    for (const key of pendingFollowUpKeys) {
      const val = await redis.get(key);
      console.log(`  ${key}: ${JSON.stringify(val)}`);
    }
    console.log("");
  }

  // Summary
  console.log("═══════════════════════════════════════");
  console.log("📊 SUMMARY");
  console.log("═══════════════════════════════════════\n");

  const pendingTasks = tasks.filter(t => t.status === "pending");
  const overdueTasks = pendingTasks.filter(t => t.nextReminder < now);
  const dayOnlyTasks = pendingTasks.filter(t => t.isDayOnly);
  const timedTasks = pendingTasks.filter(t => !t.isDayOnly);
  const activeLists = lists.filter(l => l.status === "active");

  console.log(`Total keys: ${allKeys.length}`);
  console.log(`Pending tasks: ${pendingTasks.length} (${overdueTasks.length} overdue)`);
  console.log(`  - Day-only: ${dayOnlyTasks.length}`);
  console.log(`  - Timed: ${timedTasks.length}`);
  console.log(`Active lists: ${activeLists.length}`);
  console.log(`Cross-reference issues: ${issues}`);
  console.log(`Orphaned task IDs in sets: ${orphanedTaskKeys.length}`);
}

inspectRedis().catch(console.error);
