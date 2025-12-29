/**
 * Redis Cleanup Script
 * Run with: npx tsx scripts/cleanup-redis.ts
 *
 * This script removes orphaned data:
 * - Task IDs in sets that don't have corresponding task data
 * - List IDs in sets that don't have corresponding list data
 * - Completed/cancelled tasks older than 7 days
 * - Broken cross-references
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

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

if (DRY_RUN) {
  console.log("🔍 DRY RUN MODE - No changes will be made\n");
} else if (!FORCE) {
  console.log("⚠️  This will modify your database!");
  console.log("   Run with --dry-run to preview changes");
  console.log("   Run with --force to execute changes\n");
  process.exit(1);
}

interface Task {
  id: string;
  chatId: number;
  content: string;
  status: string;
  createdAt: number;
  linkedListId?: string;
}

interface List {
  id: string;
  chatId: number;
  name: string;
  status: string;
  linkedTaskId?: string;
}

interface BrainDump {
  id: string;
  chatId: number;
  content: string;
  createdAt: number;
}

async function cleanup() {
  console.log("🧹 Cleaning up Redis database...\n");

  // Get all keys
  let cursor = 0;
  const allKeys: string[] = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, { count: 100 });
    cursor = Number(nextCursor);
    allKeys.push(...keys);
  } while (cursor !== 0);

  console.log(`Found ${allKeys.length} total keys\n`);

  let cleaned = 0;

  // Clean orphaned task IDs from sets
  console.log("Checking task sets...");
  const tasksSetKeys = allKeys.filter(k => k.startsWith("tasks:"));

  for (const setKey of tasksSetKeys) {
    const chatId = setKey.split(":")[1];
    const taskIds = await redis.smembers(setKey) as string[];

    for (const taskId of taskIds) {
      const taskKey = `task:${chatId}:${taskId}`;
      const exists = allKeys.includes(taskKey);

      if (!exists) {
        console.log(`  Removing orphaned task ID ${taskId} from ${setKey}`);
        if (!DRY_RUN) {
          await redis.srem(setKey, taskId);
        }
        cleaned++;
      }
    }
  }

  // Clean orphaned list IDs from sets
  console.log("Checking list sets...");
  const listsSetKeys = allKeys.filter(k => k.startsWith("lists:"));

  for (const setKey of listsSetKeys) {
    const chatId = setKey.split(":")[1];
    const listIds = await redis.smembers(setKey) as string[];

    for (const listId of listIds) {
      const listKey = `list:${chatId}:${listId}`;
      const exists = allKeys.includes(listKey);

      if (!exists) {
        console.log(`  Removing orphaned list ID ${listId} from ${setKey}`);
        if (!DRY_RUN) {
          await redis.srem(setKey, listId);
        }
        cleaned++;
      }
    }
  }

  // Clean old completed/cancelled tasks (older than 7 days)
  console.log("Checking for old completed tasks...");
  const taskKeys = allKeys.filter(k => k.startsWith("task:") && k.split(":").length === 3);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const key of taskKeys) {
    const task = await redis.get(key) as Task | null;

    if (task && (task.status === "completed" || task.status === "cancelled")) {
      if (task.createdAt < sevenDaysAgo) {
        console.log(`  Removing old ${task.status} task: "${task.content}"`);
        if (!DRY_RUN) {
          await redis.del(key);
          await redis.srem(`tasks:${task.chatId}`, task.id);
        }
        cleaned++;
      }
    }
  }

  // Clean old brain dumps (older than 14 days)
  console.log("Checking for old brain dumps...");
  const dumpKeys = allKeys.filter(k => k.startsWith("dump:") && k.split(":").length === 3);
  const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

  for (const key of dumpKeys) {
    const dump = await redis.get(key) as BrainDump | null;

    if (dump && dump.createdAt < fourteenDaysAgo) {
      const preview = dump.content.length > 40 ? dump.content.substring(0, 40) + "..." : dump.content;
      console.log(`  Removing old brain dump: "${preview}"`);
      if (!DRY_RUN) {
        await redis.del(key);
        // Also try to remove from daily set (format: dumps:{chatId}:{date})
        const dumpDate = new Date(dump.createdAt).toISOString().split("T")[0];
        await redis.srem(`dumps:${dump.chatId}:${dumpDate}`, dump.id);
      }
      cleaned++;
    }
  }

  // Fix broken task -> list references
  console.log("Checking task -> list references...");
  const listKeys = allKeys.filter(k => k.startsWith("list:") && k.split(":").length === 3);
  const lists: List[] = [];

  for (const key of listKeys) {
    const list = await redis.get(key) as List | null;
    if (list) lists.push(list);
  }

  for (const key of taskKeys) {
    const task = await redis.get(key) as Task | null;

    if (task && task.linkedListId) {
      const linkedList = lists.find(l => l.id === task.linkedListId);

      if (!linkedList) {
        console.log(`  Clearing broken linkedListId on task "${task.content}"`);
        if (!DRY_RUN) {
          delete task.linkedListId;
          await redis.set(key, JSON.stringify(task));
        }
        cleaned++;
      }
    }
  }

  // Fix broken list -> task references
  console.log("Checking list -> task references...");
  const tasks: Task[] = [];

  for (const key of taskKeys) {
    const task = await redis.get(key) as Task | null;
    if (task) tasks.push(task);
  }

  for (const key of listKeys) {
    const list = await redis.get(key) as List | null;

    if (list && list.linkedTaskId) {
      const linkedTask = tasks.find(t => t.id === list.linkedTaskId);

      if (!linkedTask) {
        console.log(`  Clearing broken linkedTaskId on list "${list.name}"`);
        if (!DRY_RUN) {
          delete list.linkedTaskId;
          await redis.set(key, JSON.stringify(list));
        }
        cleaned++;
      }
    }
  }

  // Clean orphaned user preferences (chat IDs with no tasks or lists)
  console.log("Checking for orphaned user preferences...");
  const userPrefsKeys = allKeys.filter(k => k.startsWith("user_prefs:"));

  for (const key of userPrefsKeys) {
    const chatId = key.split(":")[1];
    const hasTasksSet = allKeys.includes(`tasks:${chatId}`);
    const hasListsSet = allKeys.includes(`lists:${chatId}`);
    const hasConversation = allKeys.includes(`conversation:${chatId}`);

    // Known test chat IDs (common test values)
    const isTestChatId = chatId === "12345" || chatId === "123456789" || chatId === "0";

    if (isTestChatId || (!hasTasksSet && !hasListsSet && !hasConversation)) {
      console.log(`  Removing orphaned user_prefs for chat ${chatId}${isTestChatId ? " (test data)" : ""}`);
      if (!DRY_RUN) {
        await redis.del(key);
      }
      cleaned++;
    }
  }

  console.log(`\n✅ ${DRY_RUN ? "Would clean" : "Cleaned"} ${cleaned} items`);
}

cleanup().catch(console.error);
