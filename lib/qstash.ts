import { Client } from "@upstash/qstash";
import type { NotificationPayload } from "./types.js";

let qstashClient: Client | null = null;

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
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.BASE_URL;

  if (!baseUrl) {
    throw new Error("VERCEL_URL or BASE_URL is not set");
  }

  return `${baseUrl}/api/notify`;
}

export async function scheduleReminder(
  chatId: number,
  taskId: string,
  delayMinutes: number,
  isNag: boolean = false
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  console.log(`QStash: Scheduling to ${notifyUrl} with delay ${delayMinutes * 60}s`);

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

export async function scheduleDailySummary(
  chatId: number,
  cronExpression: string = "0 20 * * *" // 8 PM daily
): Promise<string> {
  const client = getClient();
  const notifyUrl = getNotifyUrl();

  const payload: NotificationPayload = {
    chatId,
    taskId: "", // Not used for daily summary
    type: "daily_summary",
  };

  const schedule = await client.schedules.create({
    destination: notifyUrl,
    cron: cronExpression,
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
  });

  return schedule.scheduleId;
}

export async function cancelScheduledMessage(messageId: string): Promise<void> {
  const client = getClient();
  try {
    await client.messages.delete(messageId);
  } catch {
    // Message may have already been delivered or doesn't exist
    console.log(`Could not cancel message ${messageId}, it may have already been processed`);
  }
}

// Verify QStash webhook signature
export async function verifySignature(
  signature: string,
  body: string
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

