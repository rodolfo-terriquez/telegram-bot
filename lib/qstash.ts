import { Client } from "@upstash/qstash";
import type { NotificationPayload } from "./types.js";

let qstashClient: Client | null = null;

// Get user's timezone from env (defaults to America/Los_Angeles)
function getUserTimezone(): string {
  return process.env.USER_TIMEZONE || "America/Los_Angeles";
}

// Prepend CRON_TZ to cron expression for timezone-aware scheduling
function withTimezone(cronExpression: string): string {
  const tz = getUserTimezone();
  return `CRON_TZ=${tz} ${cronExpression}`;
}

function getClient(): Client {
  if (!qstashClient) {
    const token = process.env.QSTASH_TOKEN;
    if (!token) {
      throw new Error("QSTASH_TOKEN is not set");
    }
    qstashClient = new Client({ token });
  }
  return qstashClient;
}

function getNotifyUrl(): string {
  // Prefer BASE_URL (stable production URL) over VERCEL_URL (deployment-specific)
  const baseUrl =
    process.env.BASE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

  if (!baseUrl) {
    throw new Error("BASE_URL or VERCEL_URL is not set");
  }

  return `${baseUrl}/api/notify`;
}

export async function scheduleReminder(
  chatId: number,
  taskId: string,
  delayMinutes: number,
  isNag: boolean = false,
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  console.log(
    `QStash: Scheduling to ${notifyUrl} with delay ${delayMinutes * 60}s`,
  );

  const payload: NotificationPayload = {
    chatId,
    taskId,
    type: isNag ? "nag" : "reminder",
  };

  const result = await client.publishJSON({
    url: notifyUrl,
    body: payload,
    delay: delayMinutes * 60, // Convert to seconds
    retries: 3,
  });

  console.log(`QStash: Message ID ${result.messageId}`);
  return result.messageId;
}

export async function scheduleDailyCheckin(
  chatId: number,
  cronExpression: string = "0 20 * * *", // 8 PM daily by default
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  const payload: NotificationPayload = {
    chatId,
    taskId: "",
    type: "daily_checkin",
  };

  const schedule = await client.schedules.create({
    destination: notifyUrl,
    cron: withTimezone(cronExpression),
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
  });

  return schedule.scheduleId;
}

export async function scheduleWeeklySummary(
  chatId: number,
  cronExpression: string = "0 20 * * 0", // 8 PM on Sundays
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  const payload: NotificationPayload = {
    chatId,
    taskId: "",
    type: "weekly_summary",
  };

  const schedule = await client.schedules.create({
    destination: notifyUrl,
    cron: withTimezone(cronExpression),
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
  });

  return schedule.scheduleId;
}

export async function scheduleEndOfDay(
  chatId: number,
  cronExpression: string = "0 0 * * *", // Midnight daily
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  const payload: NotificationPayload = {
    chatId,
    taskId: "",
    type: "end_of_day",
  };

  const schedule = await client.schedules.create({
    destination: notifyUrl,
    cron: withTimezone(cronExpression),
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
  });

  return schedule.scheduleId;
}

export async function scheduleMorningReview(
  chatId: number,
  cronExpression: string = "0 8 * * *", // 8 AM daily by default
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  const payload: NotificationPayload = {
    chatId,
    taskId: "",
    type: "morning_review",
  };

  const schedule = await client.schedules.create({
    destination: notifyUrl,
    cron: withTimezone(cronExpression),
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
  });

  return schedule.scheduleId;
}

export async function scheduleFollowUp(
  chatId: number,
  taskId: string,
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  // Random delay between 5-10 minutes for a more natural feel
  const delayMinutes = 5 + Math.random() * 5;

  console.log(
    `QStash: Scheduling follow-up to ${notifyUrl} with delay ${Math.round(delayMinutes * 60)}s`,
  );

  const payload: NotificationPayload = {
    chatId,
    taskId,
    type: "follow_up",
  };

  const result = await client.publishJSON({
    url: notifyUrl,
    body: payload,
    delay: Math.round(delayMinutes * 60), // Convert to seconds
    retries: 3,
  });

  console.log(`QStash: Follow-up message ID ${result.messageId}`);
  return result.messageId;
}

export async function deleteSchedule(scheduleId: string): Promise<void> {
  const client = getClient();
  try {
    await client.schedules.delete(scheduleId);
  } catch {
    console.log(`Could not delete schedule ${scheduleId}, it may not exist`);
  }
}

export async function cancelScheduledMessage(messageId: string): Promise<void> {
  const client = getClient();
  try {
    await client.messages.delete(messageId);
  } catch {
    // Message may have already been delivered or doesn't exist
    console.log(
      `Could not cancel message ${messageId}, it may have already been processed`,
    );
  }
}

// Verify QStash webhook signature
export async function verifySignature(
  signature: string,
  body: string,
): Promise<boolean> {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentSigningKey || !nextSigningKey) {
    console.warn("QStash signing keys not set, skipping verification");
    return true; // Skip verification in development
  }

  // Import the Receiver for verification
  const { Receiver } = await import("@upstash/qstash");
  const receiver = new Receiver({
    currentSigningKey,
    nextSigningKey,
  });

  try {
    await receiver.verify({
      signature,
      body,
    });
    return true;
  } catch {
    return false;
  }
}
