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
  | MultipleRemindersIntent
  | ReminderWithListIntent
  | BrainDumpIntent
  | InboxIntent
  | MarkDoneIntent
  | CancelTaskIntent
  | CancelMultipleTasksIntent
  | ListTasksIntent
  | CreateListIntent
  | ShowListsIntent
  | ShowListIntent
  | ModifyListIntent
  | DeleteListIntent
  | ConversationIntent
  | CheckinResponseIntent
  | SetCheckinTimeIntent;

export interface ReminderIntent {
  type: "reminder";
  task: string;
  delayMinutes: number;
  isImportant: boolean;
}

export interface ReminderItem {
  task: string;
  delayMinutes: number;
  isImportant: boolean;
}

export interface MultipleRemindersIntent {
  type: "multiple_reminders";
  reminders: ReminderItem[];
}

export interface BrainDumpIntent {
  type: "brain_dump";
  content: string;
}

export interface InboxIntent {
  type: "inbox";
  item: string;
}

export interface MarkDoneIntent {
  type: "mark_done";
  taskDescription?: string;
}

export interface CancelTaskIntent {
  type: "cancel_task";
  taskDescription?: string;
}

export interface CancelMultipleTasksIntent {
  type: "cancel_multiple_tasks";
  taskDescriptions: string[];
}

export interface ListTasksIntent {
  type: "list_tasks";
}

export interface ConversationIntent {
  type: "conversation";
  response: string;
}

export interface CheckinResponseIntent {
  type: "checkin_response";
  rating: number;
  notes?: string;
}

export interface SetCheckinTimeIntent {
  type: "set_checkin_time";
  hour: number;
  minute: number;
}

// List intent types
export interface ReminderWithListIntent {
  type: "reminder_with_list";
  task: string;
  listName: string;
  items: string[];
  delayMinutes: number;
  isImportant: boolean;
}

export interface CreateListIntent {
  type: "create_list";
  name: string;
  items: string[];
}

export interface ShowListsIntent {
  type: "show_lists";
}

export interface ShowListIntent {
  type: "show_list";
  listDescription?: string;
}

export interface ModifyListIntent {
  type: "modify_list";
  listDescription?: string;
  action:
    | "add_items"
    | "remove_items"
    | "check_items"
    | "uncheck_items"
    | "rename";
  items?: string[];
  newName?: string;
}

export interface DeleteListIntent {
  type: "delete_list";
  listDescription?: string;
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
  linkedListId?: string;
  createdAt: number;
  status: "pending" | "completed";
}

export interface ListItem {
  id: string;
  content: string;
  isChecked: boolean;
  createdAt: number;
}

export interface List {
  id: string;
  chatId: number;
  name: string;
  items: ListItem[];
  linkedTaskId?: string;
  createdAt: number;
  updatedAt: number;
  status: "active" | "completed";
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
  type:
    | "reminder"
    | "nag"
    | "daily_checkin"
    | "weekly_summary"
    | "follow_up"
    | "end_of_day";
}

// Daily check-in data
export interface CheckIn {
  id: string;
  chatId: number;
  date: string; // YYYY-MM-DD
  rating: number; // 1-5 scale
  notes?: string;
  createdAt: number;
}

// User preferences for check-in scheduling
export interface UserPreferences {
  chatId: number;
  checkinTime: string; // "HH:MM" format, default "20:00"
  checkinScheduleId?: string;
  weeklySummaryScheduleId?: string;
  endOfDayScheduleId?: string;
}
