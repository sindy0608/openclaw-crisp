/**
 * Crisp Channel Plugin - Types
 */

import { z } from "zod";

// ============================================================================
// Config Types
// ============================================================================

export const CrispConfigSchema = z.object({
  /** Crisp website ID (UUID) */
  websiteId: z.string().uuid(),
  /** Crisp API key identifier */
  apiKeyId: z.string().min(1),
  /** Crisp API key secret */
  apiKeySecret: z.string().min(1),
  /** Webhook endpoint path */
  webhookPath: z.string().default("/crisp-webhook"),
  /** Secret for webhook URL validation */
  webhookSecret: z.string().min(16),
  /** Enable/disable the channel */
  enabled: z.boolean().default(true),
  /** Display name for this account */
  name: z.string().optional(),
  /** AI auto-responds to visitors (disabled by default) */
  autoReply: z.boolean().default(false),
  /** Auto-reply message template ({name} will be replaced with visitor name) */
  autoReplyMessage: z.string().default("Hello {name}! Thanks for reaching out. We'll get back to you shortly."),
  /** Name shown as operator in Crisp */
  operatorName: z.string().default("Assistant"),
  /** Avatar URL for operator */
  operatorAvatar: z.string().url().optional(),
  /** Send notification on new conversations */
  notifyOnNew: z.boolean().default(false),
  /** Target for notifications (e.g., telegram:123456) */
  notifyTarget: z.string().optional(),
  /** Messages to include as AI context */
  historyLimit: z.number().int().min(0).max(50).default(10),
  /** Mark conversation resolved after reply */
  resolveOnReply: z.boolean().default(false),
  /** Human-in-the-loop approval mode: send to Telegram for approval before replying */
  approvalMode: z.boolean().default(false),
  /** Telegram chat ID for approval notifications */
  approvalChatId: z.string().optional(),
  /** Telegram forum topic/thread ID for approval notifications */
  approvalThreadId: z.union([z.string(), z.number().int()]).optional(),
  /** Backward-compatible alias for approvalThreadId */
  approvalTopicId: z.union([z.string(), z.number().int()]).optional(),
  /** Telegram bot token (from Clawdbot config) */
  telegramBotToken: z.string().optional(),
  /** Hard timeout for one auto-reply attempt before fixed fallback is sent */
  autoReplyTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  /** Final fallback message used only when no valid auto-reply was sent */
  autoReplyFailureMessage: z.string().default("抱歉，当前咨询较多，系统处理稍慢，请稍后再发一次，或发送「人工」联系人工客服。"),
  /** Conservative fallback message used only when dispatch completed with no valid deliver */
  autoReplyNoValidDeliverMessage: z.string().default("已收到你的消息，我这边先帮你看一下，请稍等。"),
  /** Conservative fallback message used when dispatch errored before a valid reply reached Crisp */
  autoReplyDispatchErrorMessage: z.string().default("已收到你的消息，刚刚发送时出现一点延迟，我这边继续帮你处理，请稍等。"),
  /** Enable conservative proactive conversation sweep for missed webhooks */
  proactiveSweepEnabled: z.boolean().default(true),
  /** Sweep interval in milliseconds */
  proactiveSweepIntervalMs: z.number().int().min(10000).max(3600000).default(60000),
  /** Only inspect conversations updated within this window */
  proactiveSweepWindowMs: z.number().int().min(60000).max(86400000).default(600000),
  /** Max recent conversations fetched per state per sweep */
  proactiveSweepConversationLimit: z.number().int().min(1).max(100).default(20),
  /** Max recent messages fetched per conversation during sweep */
  proactiveSweepMessageLimit: z.number().int().min(2).max(50).default(10),
});

export type CrispConfig = z.infer<typeof CrispConfigSchema>;

// ============================================================================
// Crisp API Types
// ============================================================================

export interface CrispWebhookPayload {
  website_id: string;
  event: string;
  data: CrispWebhookData;
  timestamp: number;
}

export interface CrispWebhookData {
  website_id: string;
  session_id: string;
  type?: "text" | "file" | "animation" | "audio" | "picker" | "field" | "carousel";
  content?: string;
  from?: "user" | "operator";
  origin?: "chat" | "email";
  stamped?: boolean;
  timestamp?: number;
  fingerprint?: number;
  user?: {
    nickname: string;
    user_id: string;
  };
  // Session state events
  state?: "pending" | "unresolved" | "resolved";
  // Email events
  email?: string;
  // Nickname events
  nickname?: string;
}

export interface CrispMessage {
  session_id: string;
  website_id: string;
  type: "text" | "file" | "animation" | "audio" | "note";
  content: string;
  from: "user" | "operator";
  origin: "chat" | "email";
  timestamp: number;
  fingerprint: number;
  user?: {
    nickname: string;
    user_id: string;
    avatar?: string;
  };
}

export interface CrispConversation {
  session_id: string;
  website_id: string;
  state: "pending" | "unresolved" | "resolved";
  is_verified: boolean;
  is_blocked: boolean;
  availability: "online" | "offline";
  created_at: number;
  updated_at: number;
  inbox_id?: string | null;
  meta: {
    nickname?: string;
    email?: string;
    phone?: string;
    avatar?: string;
    ip?: string;
    device?: {
      geolocation?: {
        country?: string;
        city?: string;
      };
    };
  };
}

export interface CrispConversationListItem {
  session_id: string;
  website_id: string;
  state: "pending" | "unresolved" | "resolved";
  created_at?: number;
  updated_at?: number;
  inbox_id?: string | null;
  meta?: {
    nickname?: string;
    email?: string;
  };
}

export interface CrispSendMessageParams {
  websiteId: string;
  sessionId: string;
  content: string;
  type?: "text" | "file" | "animation";
  from?: "operator";
  origin?: "chat";
}

export interface CrispSendMessageResponse {
  error: boolean;
  reason?: string;
  data?: {
    fingerprint: number;
  };
}

// ============================================================================
// Internal Types
// ============================================================================

export interface CrispSessionState {
  sessionId: string;
  websiteId: string;
  accountId: string;
  visitorName: string;
  visitorEmail?: string;
  startedAt: number;
  lastMessageAt: number;
  messageCount: number;
  isNew: boolean;
}

export interface ResolvedCrispAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  config: CrispConfig;
  baseUrl: string;
}

// ============================================================================
// Constants
// ============================================================================

export const CRISP_API_BASE = "https://api.crisp.chat/v1";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBHOOK_PATH = "/crisp-webhook";

// ============================================================================
// Helpers
// ============================================================================

export function buildCrispApiUrl(path: string): string {
  return `${CRISP_API_BASE}${path}`;
}

export function buildCrispDashboardUrl(websiteId: string, sessionId: string): string {
  return `https://app.crisp.chat/website/${websiteId}/inbox/${sessionId}`;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}
