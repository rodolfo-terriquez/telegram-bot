// Telegram types
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  voice?: TelegramVoice;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// Intent types from Claude
export type Intent =
  | ReminderIntent
  | BrainDumpIntent
  | MarkDoneIntent
  | DeleteReminderIntent
  | ListTasksIntent
  | ConversationIntent;

export interface ReminderIntent {
  type: "reminder";
  task: string;
  delayMinutes: number;
  isImportant: boolean;
}

export interface BrainDumpIntent {
  type: "brain_dump";
  content: string;
}

export interface MarkDoneIntent {
  type: "mark_done";
  taskDescription?: string;
}

export interface DeleteReminderIntent {
  type: "delete_reminder";
  taskDescription?: string;
}

export interface ListTasksIntent {
  type: "list_tasks";
}

export interface ConversationIntent {
  type: "conversation";
  response: string;
}

// Data models for Redis
export interface Task {
  id: string;
  chatId: number;
  content: string;
  isImportant: boolean;
  naggingLevel: number;
  nextReminder: number;
  qstashMessageId?: string;
  createdAt: number;
  status: "pending" | "completed";
}

export interface BrainDump {
  id: string;
  chatId: number;
  content: string;
  createdAt: number;
}

// QStash notification payload
export interface NotificationPayload {
  chatId: number;
  taskId: string;
  type: "reminder" | "nag" | "daily_summary";
}
