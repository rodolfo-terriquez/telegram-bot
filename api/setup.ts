import type { VercelRequest, VercelResponse } from "@vercel/node";
import { setWebhook } from "../lib/telegram";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow GET requests for easy browser access
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Get the base URL from Vercel environment or query parameter
  const baseUrl =
    (req.query.url as string) ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

  if (!baseUrl) {
    res.status(400).json({
      error: "No base URL provided",
      hint: "Pass ?url=https://your-domain.vercel.app or set VERCEL_URL",
    });
    return;
  }

  const webhookUrl = `${baseUrl}/api/telegram`;

  try {
    await setWebhook(webhookUrl);
    res.status(200).json({
      success: true,
      message: "Webhook set successfully",
      webhookUrl,
    });
  } catch (error) {
    console.error("Setup error:", error);
    res.status(500).json({
      error: "Failed to set webhook",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

