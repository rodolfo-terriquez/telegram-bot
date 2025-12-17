import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow GET requests for easy browser access
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // Check if TELEGRAM_BOT_TOKEN is set
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      res.status(400).json({
        error: "TELEGRAM_BOT_TOKEN is not set",
        hint: "Add TELEGRAM_BOT_TOKEN to your Vercel environment variables",
      });
      return;
    }

    // Get the base URL from Vercel environment or query parameter
    const baseUrl =
      (req.query.url as string) ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

    if (!baseUrl) {
      res.status(400).json({
        error: "No base URL provided",
        hint: "Pass ?url=https://your-domain.vercel.app",
        vercel_url: process.env.VERCEL_URL || "not set",
      });
      return;
    }

    const webhookUrl = `${baseUrl}/api/telegram`;

    // Set webhook using fetch directly to avoid import issues
    const response = await fetch(
      `https://api.telegram.org/bot${token}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl }),
      }
    );

    const data = (await response.json()) as { ok: boolean; description?: string };

    if (!response.ok || !data.ok) {
      res.status(500).json({
        error: "Failed to set webhook",
        telegramResponse: data,
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Webhook set successfully!",
      webhookUrl,
      telegramResponse: data,
    });
  } catch (error) {
    console.error("Setup error:", error);
    res.status(500).json({
      error: "Failed to set webhook",
      details: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

