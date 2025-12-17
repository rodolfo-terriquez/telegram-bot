# ADHD Support Telegram Bot

A Telegram bot designed to help manage ADHD through natural language task reminders, voice message transcription, brain dump capture, and intelligent gentle nagging.

## Features

- **Voice Message Transcription**: Send voice notes for hands-free interaction using OpenAI Whisper
- **Natural Language Reminders**: "Remind me to call the dentist in 2 hours"
- **Brain Dump Capture**: Quickly capture thoughts with daily summaries
- **Smart Gentle Nagging**: Escalating reminders for important tasks until done
- **Daily Summaries**: Get a recap of your thoughts and pending tasks

## Tech Stack

- **Runtime**: Vercel Serverless Functions (TypeScript)
- **LLM**: Anthropic Claude 3.5 Sonnet
- **Transcription**: OpenAI Whisper
- **Database**: Upstash Redis
- **Scheduler**: Upstash QStash
- **Bot Interface**: Telegram Bot API

## Setup

### 1. Create Required Accounts

1. **Telegram Bot**: Message [@BotFather](https://t.me/BotFather) on Telegram
   - Send `/newbot` and follow the prompts
   - Save the bot token

2. **Vercel**: Sign up at [vercel.com](https://vercel.com)

3. **OpenAI**: Get an API key from [platform.openai.com](https://platform.openai.com/api-keys)

4. **Anthropic**: Get an API key from [console.anthropic.com](https://console.anthropic.com/)

5. **Upstash**: Sign up at [console.upstash.com](https://console.upstash.com/)
   - Create a Redis database
   - Enable QStash

### 2. Clone and Configure

```bash
# Clone the repository
git clone <your-repo-url>
cd telegram-bot

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local
```

Fill in all the values in `.env.local`.

### 3. Deploy to Vercel

```bash
# Install Vercel CLI if needed
npm i -g vercel

# Deploy
vercel

# Set environment variables in Vercel dashboard
# Or use: vercel env add TELEGRAM_BOT_TOKEN
```

### 4. Set Telegram Webhook

After deployment, set your webhook URL:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-app.vercel.app/api/telegram"}'
```

### 5. (Optional) Set Up Daily Summary

Create a QStash schedule in the Upstash dashboard:
- **Destination**: `https://your-app.vercel.app/api/notify`
- **Cron**: `0 20 * * *` (8 PM daily)
- **Body**: `{"chatId": YOUR_CHAT_ID, "taskId": "", "type": "daily_summary"}`

To get your chat ID, send a message to your bot and check the Vercel function logs.

## Usage

### Reminders
- "Remind me to take my meds in 30 minutes"
- "In 2 hours remind me to call mom"
- "Important: submit the report by 5pm - nag me" (enables gentle nagging)

### Brain Dumps
- "Dump: random thought about the project"
- "Note to self: look into that new framework"
- Just send any stream of consciousness text

### Managing Tasks
- "Done" - marks the most recent task complete
- "Finished calling mom" - marks a specific task complete
- "List tasks" - shows all pending reminders
- "What do I have pending?" - shows tasks

### Voice Messages
Just send a voice note! The bot will transcribe it and process it like text.

## Development

```bash
# Run locally with Vercel dev
npm run dev

# Type check
npm run type-check
```

For local development, you'll need to use a tool like ngrok to expose your local server for Telegram webhooks.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Telegram  │────▶│    Vercel    │────▶│   Claude    │
│     App     │     │   Functions  │     │  (Intent)   │
└─────────────┘     └──────────────┘     └─────────────┘
       │                   │                    │
       │                   ▼                    │
       │            ┌──────────────┐            │
       │            │   Whisper    │◀───────────┘
       │            │(Transcribe)  │
       │            └──────────────┘
       │                   │
       │                   ▼
       │            ┌──────────────┐
       │            │    Redis     │
       │            │  (Storage)   │
       │            └──────────────┘
       │                   │
       │                   ▼
       │            ┌──────────────┐
       │◀───────────│   QStash    │
       │            │ (Scheduler)  │
                    └──────────────┘
```

## License

MIT

