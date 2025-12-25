import type { TelegramFile } from "./types.js";

const TELEGRAM_API = "https://api.telegram.org/bot";

function getToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  return token;
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  const token = getToken();
  console.log(`[Telegram] Sending message to ${chatId}, length: ${text.length}`);

  // Try with Markdown first
  let response = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });

  // If Markdown parsing fails, retry without parse_mode
  if (!response.ok) {
    const errorText = await response.text();

    // Check if it's a parsing error (common with different model outputs)
    if (errorText.includes("can't parse") || errorText.includes("Bad Request")) {
      console.warn("Markdown parsing failed, retrying without parse_mode:", errorText);

      response = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
        }),
      });

      if (!response.ok) {
        const retryError = await response.text();
        throw new Error(`Failed to send message: ${retryError}`);
      }
      console.log(`[Telegram] Message sent successfully (plain text fallback)`);
      return;
    }

    throw new Error(`Failed to send message: ${errorText}`);
  }
  console.log(`[Telegram] Message sent successfully`);
}

export async function getFilePath(fileId: string): Promise<string> {
  const token = getToken();
  const response = await fetch(`${TELEGRAM_API}${token}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get file: ${error}`);
  }

  const data = (await response.json()) as { ok: boolean; result: TelegramFile };
  if (!data.ok || !data.result.file_path) {
    throw new Error("Failed to get file path from Telegram");
  }

  return data.result.file_path;
}

export async function downloadFile(filePath: string): Promise<Buffer> {
  const token = getToken();
  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function setWebhook(webhookUrl: string): Promise<void> {
  const token = getToken();
  const response = await fetch(`${TELEGRAM_API}${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to set webhook: ${error}`);
  }
}

export async function sendDocument(
  chatId: number,
  content: string,
  filename: string,
  caption?: string,
): Promise<void> {
  const token = getToken();

  // Create form data with the file
  const formData = new FormData();
  formData.append("chat_id", chatId.toString());
  formData.append("document", new Blob([content], { type: "text/markdown" }), filename);
  if (caption) {
    formData.append("caption", caption);
  }

  const response = await fetch(`${TELEGRAM_API}${token}/sendDocument`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to send document: ${error}`);
  }
}
