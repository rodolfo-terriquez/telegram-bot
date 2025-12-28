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
- **LLM**: OpenRouter (configurable models for intent parsing vs chat)
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

4. **OpenRouter**: Get an API key from [openrouter.ai](https://openrouter.ai/keys)

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
│   Telegram  │────▶│    Vercel    │────▶│ OpenRouter  │
│     App     │     │   Functions  │     │    (LLM)    │
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

## Environment Variables

### Required
| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `OPENAI_API_KEY` | For Whisper transcription |
| `OPENROUTER_API_KEY` | For LLM access |
| `UPSTASH_REDIS_REST_URL` | Redis connection URL |
| `UPSTASH_REDIS_REST_TOKEN` | Redis auth token |
| `QSTASH_TOKEN` | QStash API token |
| `QSTASH_CURRENT_SIGNING_KEY` | Webhook verification |
| `QSTASH_NEXT_SIGNING_KEY` | Webhook verification |
| `BASE_URL` | Production URL for QStash callbacks |

### Optional
| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_MODEL_CHAT` | `x-ai/grok-3-fast` | Model for chat responses |
| `OPENROUTER_MODEL_INTENT` | (uses chat model) | Model for intent parsing |
| `OPENROUTER_CHAT_PARAMS` | `{}` | JSON object with extra API params for chat |
| `OPENROUTER_INTENT_PARAMS` | `{}` | JSON object with extra API params for intent |
| `ALLOWED_USERS` | (none) | Comma-separated usernames/IDs for access control |
| `USER_TIMEZONE` | `America/Los_Angeles` | User's timezone |
| `BRAINTRUST_API_KEY` | (none) | For LLM call tracing |

### Example: Configuring Model Parameters
```bash
# Use different models for intent parsing vs chat
OPENROUTER_MODEL_CHAT=anthropic/claude-3.5-sonnet
OPENROUTER_MODEL_INTENT=openai/gpt-4o-mini

# Disable reasoning for intent parsing (useful for reasoning models)
OPENROUTER_INTENT_PARAMS={"reasoning":false}

# Set temperature for chat responses  
OPENROUTER_CHAT_PARAMS={"temperature":0.7}

# Nested parameters (e.g., OpenAI reasoning effort)
OPENROUTER_INTENT_PARAMS={"reasoning":{"effort":"low"}}
```

## License

MIT

