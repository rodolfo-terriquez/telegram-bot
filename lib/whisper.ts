import OpenAI from "openai";

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const client = getClient();

  // Create a File object from the buffer
  // Telegram voice messages are in OGG format
  const file = new File([audioBuffer], "voice.ogg", { type: "audio/ogg" });

  const transcription = await client.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: "en",
  });

  return transcription.text;
}

