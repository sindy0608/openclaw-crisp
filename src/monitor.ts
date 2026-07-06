/**
 * Crisp Webhook Handler
 * 
 * Receives HTTP POST requests from Crisp and routes them to Clawdbot.
 * Supports human-in-the-loop approval mode.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import {
  DEFAULT_WEBHOOK_PATH,
  type CrispConfig,
  type CrispConversationListItem,
  type CrispMessage,
  type CrispSessionState,
  type CrispWebhookPayload,
  truncateText,
} from "./types.js";
import { createCrispClient } from "./api-client.js";
import {
  isHumanHandoffMessage,
  isGlobalAutoModeEnabled,
  isHumanPauseSession,
  getHumanPauseRemainingMs,
  isManagedSession,
  isManagedModeDisableCommand,
  isManagedModeEnableCommand,
  markHumanPauseSession,
  markManagedSession,
  releaseManagedSession,
} from "./managed-sessions.js";
import { buildSupportKnowledge } from "./kb.js";
import { getCrispRuntime, hasCrispRuntime } from "./runtime.js";
import { storePendingReply, updatePendingReplyTelegram } from "./pending-replies.js";
import { sendTelegramNotification } from "./telegram-notify.js";
import { isIgnoredSession, releaseIgnoredSession } from "./ignored-sessions.js";

// In-memory session tracking for notification deduplication
const activeSessions = new Map<string, CrispSessionState>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Prevent same Crisp session from running multiple auto-replies concurrently.
const sessionProcessingLocks = new Map<string, Promise<void>>();
const activeAutoRepliesByAccount = new Map<string, number>();
type PendingAutoReplySlot = { resolve: (release: () => void) => void };
const pendingAutoReplySlotsByAccount = new Map<string, PendingAutoReplySlot[]>();
const proactiveSweepRescueCooldowns = new Map<string, number>();
const sweepProcessedMessages = new Map<string, { messageKey: string; processedAt: number; source: "webhook" | "sweeper" }>();
const recentOperatorReplies = new Map<string, { at: number; fingerprint?: number; content: string }>();
const SWEEP_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const RECENT_OPERATOR_REPLY_TTL_MS = 10 * 60 * 1000;
const MAX_INBOUND_IMAGE_BYTES = 8 * 1024 * 1024;
const INBOUND_IMAGE_FETCH_TIMEOUT_MS = 10_000;
const INBOUND_IMAGE_LOCAL_RETENTION_MS = 15 * 60 * 1000;
const INBOUND_IMAGE_STALE_SWEEP_RETENTION_MS = 24 * 60 * 60 * 1000;

interface NormalizedInboundMessage {
  websiteId: string;
  sessionId: string;
  type: "text" | "file";
  content: string;
  origin: "chat" | "email";
  from: "user";
  timestampMs: number;
  fingerprint?: number;
  visitorName: string;
}

interface BufferedInboundMessage extends NormalizedInboundMessage {
  sourceMessageKeys?: string[];
  sourceFingerprints?: Array<number | undefined>;
  sourceCount?: number;
}

interface PreparedInboundMedia {
  originalUrl?: string;
  localPath?: string;
  contentType?: string;
  sizeBytes?: number;
}

function resolveAutoReplyMaxConcurrent(maxConcurrent: number | undefined): number {
  if (typeof maxConcurrent !== "number" || !Number.isFinite(maxConcurrent)) {
    return 2;
  }
  return Math.max(1, Math.floor(maxConcurrent));
}

function buildAutoReplySlotRelease(accountId: string): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;

    const queue = pendingAutoReplySlotsByAccount.get(accountId);
    const next = queue?.shift();
    if (queue && queue.length === 0) {
      pendingAutoReplySlotsByAccount.delete(accountId);
    }
    if (next) {
      // Keep the active count reserved for the next queued handler. This avoids
      // a release/acquire race where a new webhook could jump ahead of FIFO queue.
      next.resolve(buildAutoReplySlotRelease(accountId));
      return;
    }

    const current = activeAutoRepliesByAccount.get(accountId) ?? 0;
    if (current <= 1) {
      activeAutoRepliesByAccount.delete(accountId);
    } else {
      activeAutoRepliesByAccount.set(accountId, current - 1);
    }
  };
}

async function acquireAutoReplySlot(
  accountId: string,
  maxConcurrent: number | undefined,
  waitTimeoutMs: number | undefined
): Promise<(() => void) | null> {
  const safeLimit = resolveAutoReplyMaxConcurrent(maxConcurrent);
  const active = activeAutoRepliesByAccount.get(accountId) ?? 0;
  if (active < safeLimit) {
    activeAutoRepliesByAccount.set(accountId, active + 1);
    return buildAutoReplySlotRelease(accountId);
  }

  const safeWaitTimeoutMs = typeof waitTimeoutMs === "number" && Number.isFinite(waitTimeoutMs)
    ? Math.max(0, Math.floor(waitTimeoutMs))
    : 5000;
  if (safeWaitTimeoutMs === 0) {
    return null;
  }

  return new Promise((resolve) => {
    const queue = pendingAutoReplySlotsByAccount.get(accountId) ?? [];
    let settled = false;
    const entry: PendingAutoReplySlot = {
      resolve: (release) => {
        if (settled) {
          release();
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(release);
      },
    };
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      const currentQueue = pendingAutoReplySlotsByAccount.get(accountId);
      if (currentQueue) {
        const index = currentQueue.indexOf(entry);
        if (index >= 0) {
          currentQueue.splice(index, 1);
        }
        if (currentQueue.length === 0) {
          pendingAutoReplySlotsByAccount.delete(accountId);
        }
      }
      resolve(null);
    }, safeWaitTimeoutMs);
    timeoutHandle.unref?.();
    queue.push(entry);
    pendingAutoReplySlotsByAccount.set(accountId, queue);
  });
}

function getAutoReplyQueueDepth(accountId: string): number {
  return pendingAutoReplySlotsByAccount.get(accountId)?.length ?? 0;
}


// Re-export for backward compatibility
export { setCrispRuntime, getCrispRuntime } from "./runtime.js";

// Export pending replies functions for external use
export { 
  getPendingReply, 
  removePendingReply,
  findPendingReplyByTelegramMessage,
  getAllPendingReplies,
} from "./pending-replies.js";

/**
 * Get the configured webhook path
 */
export function resolveWebhookPath(config: CrispConfig): string {
  return config.webhookPath || DEFAULT_WEBHOOK_PATH;
}

/**
 * Validate the webhook secret from URL params
 */
function validateWebhookSecret(
  url: URL,
  expectedSecret: string
): boolean {
  const providedSecret = url.searchParams.get("secret");
  if (!providedSecret || !expectedSecret) return false;
  
  // Constant-time comparison to prevent timing attacks
  if (providedSecret.length !== expectedSecret.length) return false;
  let result = 0;
  for (let i = 0; i < providedSecret.length; i++) {
    result |= providedSecret.charCodeAt(i) ^ expectedSecret.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Parse JSON body from request
 */
async function parseJsonBody(req: IncomingMessage): Promise<{ parsed: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ parsed: JSON.parse(raw), raw });
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Track session for notification deduplication
 */
function trackSession(
  sessionId: string,
  websiteId: string,
  accountId: string,
  visitorName: string,
  visitorEmail?: string
): CrispSessionState {
  const trackedKey = buildTrackedSessionKey(accountId, websiteId, sessionId);
  const existing = activeSessions.get(trackedKey);
  const now = Date.now();

  if (existing) {
    existing.lastMessageAt = now;
    existing.messageCount += 1;
    existing.isNew = false;
    return existing;
  }

  const session: CrispSessionState = {
    sessionId,
    websiteId,
    accountId,
    visitorName,
    visitorEmail,
    startedAt: now,
    lastMessageAt: now,
    messageCount: 1,
    isNew: true,
  };

  activeSessions.set(trackedKey, session);

  // Cleanup old sessions periodically
  if (activeSessions.size > 100) {
    const cutoff = now - SESSION_TTL_MS;
    for (const [key, value] of activeSessions) {
      if (value.lastMessageAt < cutoff) {
        activeSessions.delete(key);
      }
    }
  }

  return session;
}

function buildTrackedSessionKey(
  accountId: string,
  websiteId: string,
  sessionId: string
): string {
  return `${accountId}:${websiteId}:${sessionId}`;
}

function buildCrispToolTarget(params: {
  accountId: string;
  websiteId: string;
  sessionId: string;
}): string {
  return `crisp:${params.accountId}:${params.websiteId}:${params.sessionId}`;
}

function buildLightweightAgentSessionKey(baseSessionKey: string, config: CrispConfig, timestampMs: number): string {
  const windowMs = config.autoReplySessionWindowMs;
  if (!windowMs || windowMs <= 0) return baseSessionKey;
  const safeTimestampMs = Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : Date.now();
  const windowId = Math.floor(safeTimestampMs / windowMs);
  return `${baseSessionKey}:w${windowId}`;
}

function formatHistoryMessageContent(content: string, maxChars: number): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return truncateText(normalized, maxChars);
}

function buildLightweightPromptBody(params: {
  normalizedMessageText: string;
  mediaContext: string;
  historyText: string;
  supportContext: string;
  outputGuard: string;
  maxChars: number;
}): string {
  const latestMessage = `\n\n[Latest customer message - answer this only]\n${params.normalizedMessageText}${params.mediaContext}\n[End of latest customer message]`;
  const latestMessageGuard = `[最新消息优先级硬性要求]\n只回答上方 [Latest customer message - answer this only] 中的最新客户消息。历史消息仅用于理解背景，不得回答历史里的旧问题；如果历史与最新消息冲突，以最新消息为准。\n[End of 最新消息优先级硬性要求]`;
  const suffix = `\n\n${params.supportContext}\n\n${latestMessage}\n\n${latestMessageGuard}\n\n${params.outputGuard}`;
  const prefixBudget = Math.max(1000, params.maxChars - suffix.length);
  const prefix = truncateText(params.historyText, prefixBudget);
  return `${prefix}${suffix}`;
}

function normalizeCrispTimestampMs(timestamp?: number): number {
  if (!timestamp || !Number.isFinite(timestamp)) return Date.now();
  // Crisp REST often uses seconds, while webhooks can send milliseconds.
  // Never multiply an already-ms timestamp, otherwise reply dedupe/handoff logic
  // can think an old operator reply happened in the future and suppress AI replies.
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

function recordRecentOperatorReply(params: {
  accountId: string;
  websiteId: string;
  sessionId: string;
  content: string;
  fingerprint?: number;
  timestampMs?: number;
}): void {
  const content = params.content.trim();
  if (!content) return;
  const key = buildTrackedSessionKey(params.accountId, params.websiteId, params.sessionId);
  const now = Date.now();
  const at = params.timestampMs && Number.isFinite(params.timestampMs) ? params.timestampMs : now;
  recentOperatorReplies.set(key, { at, fingerprint: params.fingerprint, content });
  const cutoff = now - RECENT_OPERATOR_REPLY_TTL_MS;
  const futureCutoff = now + 60_000;
  for (const [existingKey, value] of recentOperatorReplies) {
    if (value.at < cutoff || value.at > futureCutoff) {
      recentOperatorReplies.delete(existingKey);
    }
  }
}

function getRecentOperatorReplySince(sessionKey: string, sinceMs: number): { at: number; fingerprint?: number; content: string } | null {
  const reply = recentOperatorReplies.get(sessionKey);
  if (!reply) return null;
  const now = Date.now();
  if (reply.at > now + 60_000) return null;
  if (reply.at < sinceMs) return null;
  return reply;
}

function buildInboundMessageKey(message: {
  fingerprint?: number;
  timestampMs: number;
  type: string;
  content: string;
}): string {
  if (typeof message.fingerprint === "number") {
    return `fp:${message.fingerprint}`;
  }
  return `ts:${message.timestampMs}:type:${message.type}:content:${message.content}`;
}

function cleanupSweepProcessedMessages(now: number): void {
  const cutoff = now - SWEEP_DEDUP_TTL_MS;
  for (const [key, value] of sweepProcessedMessages) {
    if (value.processedAt < cutoff) {
      sweepProcessedMessages.delete(key);
    }
  }
}

function getProcessedMessageState(
  sessionKey: string,
  messageKey: string
): { messageKey: string; processedAt: number; source: "webhook" | "sweeper" } | null {
  cleanupSweepProcessedMessages(Date.now());
  const existing = sweepProcessedMessages.get(sessionKey);
  if (!existing) {
    return null;
  }
  const matched = existing.messageKey === messageKey ? existing : null;
  if (matched) {
    console.log(
      `[crisp] 🧠 Processed state hit: sessionKey=${sessionKey} messageKey=${messageKey} source=${matched.source} processedAt=${new Date(matched.processedAt).toISOString()} ageMs=${Date.now() - matched.processedAt}`
    );
  }
  return matched;
}

function markProcessedMessage(params: {
  sessionKey: string;
  messageKey: string;
  source: "webhook" | "sweeper";
}): void {
  const now = Date.now();
  const previous = sweepProcessedMessages.get(params.sessionKey);
  console.log(
    `[crisp] 🧠 Mark processed: sessionKey=${params.sessionKey} messageKey=${params.messageKey} source=${params.source} replacing=${previous ? previous.messageKey : "none"} previousSource=${previous?.source ?? "-"} previousAgeMs=${previous ? now - previous.processedAt : "-"}`
  );
  sweepProcessedMessages.set(params.sessionKey, {
    messageKey: params.messageKey,
    processedAt: now,
    source: params.source,
  });
  cleanupSweepProcessedMessages(now);
}

function extractCrispContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content && typeof content === "object") {
    const file = content as { url?: unknown; name?: unknown; type?: unknown };
    if (typeof file.url === "string" && file.url.trim()) {
      return file.url.trim();
    }
    if (typeof file.name === "string" && file.name.trim()) {
      return file.name.trim();
    }
  }
  return "";
}

function isHumanOperatorWebhook(data: CrispWebhookPayload["data"] | undefined): boolean {
  if (data?.type !== "text") {
    return false;
  }

  const user = data?.user as { nickname?: unknown; user_id?: unknown } | undefined;
  if (!user || typeof user !== "object") {
    return false;
  }

  const nickname = typeof user.nickname === "string" ? user.nickname.trim() : "";
  const userId = typeof user.user_id === "string" ? user.user_id.trim() : "";
  return Boolean(nickname || userId);
}

const SAFE_VISIBLE_FALLBACK_MESSAGE = "";
const INTERNAL_REASONING_FALLBACK = SAFE_VISIBLE_FALLBACK_MESSAGE;
const INTERNAL_FAILURE_REPLY_PATTERNS = [
  /^⚠️\s*✉️\s*Message(?:\s*:\s*[^\n]+)?\s+failed\s*$/i,
  /^⚠️\s*Something went wrong while processing your request\.\s*Please try again,?\s*or use \/new to start a fresh session\.\s*$/i,
  /^Something went wrong while processing your request\.\s*Please try again,?\s*or use \/new to start a fresh session\.\s*$/i,
  /^\[assistant turn failed before producing content\]\s*$/i,
];

function resolveSafeFallbackMessage(configured: string | undefined): string {
  return configured?.trim() ?? "";
}

function isInternalFailureReply(text: string): boolean {
  const normalized = text.trim();
  return INTERNAL_FAILURE_REPLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isVisibleCustomerReplyStart(text: string): boolean {
  return /^(您好|你好|亲爱的|尊敬的|抱歉|不好意思|非常理解|理解您|可以的|建议您|请您|目前|您可以|这边|好的|收到|感谢|谢谢|Hello|Hi|Sorry|Thanks|Thank you|Please|You can)/i.test(text.trim());
}

function isVisibleCustomerReplyHeading(text: string): boolean {
  return /^(?:#{1,4}\s*)?(?:最终回复|客户可见回复|回复客户|发送给客户|对客户说|正式回复|建议回复|Final answer|Customer-facing reply|Reply to customer|Answer)[:：]?\s*$/i.test(text.trim());
}

function isInternalReasoningHeading(text: string): boolean {
  return /^(?:#{1,4}\s*)?(?:\*\*)?\s*(?:Thinking|思考|Reasoning|推理|内部思考|内部推理|思路|处理思路|回复策略|决策记录|内部判断|Decision|Internal reasoning|Model reasoning)\s*(?:\*\*)?\s*[:：]?\s*$/i.test(text.trim());
}

function startsWithInternalReasoningHeading(text: string): boolean {
  return /^(?:#{1,4}\s*)?(?:\*\*)?\s*(?:Thinking|思考|Reasoning|推理|内部思考|内部推理|思路|处理思路|回复策略|决策记录|内部判断|Decision|Internal reasoning|Model reasoning)\s*(?:\*\*)?\s*[:：]?(?:\r?\n|$)/i.test(text.trim());
}

function isInternalDecisionRecord(text: string): boolean {
  return /^\s*(?:[-*]\s*)?(?:用户说|用户再次抱怨|用户抱怨|用户询问|用户想要|客户说|客户再次抱怨|客户抱怨|客户询问|这说明|这意味着|结合之前|根据知识库|知识库显示|我应该|我需要|我会|应该|需要确认|需要判断|看起来|这种情况|内部判断|内部决策|决策|转人工规则|分析|推理|思考|判断|处理思路|回复策略|Reasoning|Thinking|Decision|The user|The customer|I need|I should|I will|We need|Need to|Final answer|Customer-facing reply)[:：]/i.test(text.trim());
}

function isLikelyInternalMonologueParagraph(text: string): boolean {
  const normalized = text.replace(/\s+/g, "");
  if (normalized.length < 18) {
    return false;
  }
  if (isVisibleCustomerReplyStart(text) || /[您你](可以|需要|请|好|先|再|提供|确认|查看)|感谢|谢谢|抱歉|不好意思|很高兴|为您|帮您|协助您/.test(text)) {
    return false;
  }

  const analysisTerms = [
    "我",
    "用户",
    "客户",
    "应该",
    "需要",
    "看起来",
    "可能",
    "确认",
    "判断",
    "分析",
    "推理",
    "思考",
    "猜测",
    "意图",
    "上下文",
    "知识库",
    "工具",
    "规则",
    "不能",
    "不要",
    "如果",
    "先",
    "然后",
    "所以",
    "因此",
    "内部",
    "转人工",
  ];
  const hits = analysisTerms.reduce((count, term) => count + (normalized.includes(term) ? 1 : 0), 0);
  return hits >= 4 && /我|用户|客户/.test(normalized) && /应该|需要|看起来|确认|判断|分析|推理|思考|可能/.test(normalized);
}

function isLikelyEnglishInternalMonologue(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 80) {
    return false;
  }
  if (!/^[A-Za-z]/.test(trimmed)) {
    return false;
  }

  const markers = [
    /\bThe user said\b/i,
    /\bThe user is (?:asking|reporting|saying|referring|trying|likely)\b/i,
    /\bThe user might be\b/i,
    /\bThe customer (?:said|is|might|asked|wants|needs)\b/i,
    /\bLooking at the (?:context|knowledge base|conversation|previous messages|previous conversation)\b/i,
    /\bFrom the knowledge base\b/i,
    /\bBased on the (?:context|knowledge base|conversation|information|above|messages)\b/i,
    /\bI need to\b/i,
    /\bI should\b/i,
    /\bI will\b/i,
    /\bI think (?:the user|the customer|they|we should|I should|this is|it is|this means|it means)\b/i,
    /\bWait[,，]\b/,
    /\bActually[,，]\b/,
    /\bIn summary[,，:]\b/i,
    /\bThis is a (?:Mielink|Crisp|customer|user|client|standard|common|typical)\b/i,
  ];

  let hits = 0;
  for (const marker of markers) {
    if (marker.test(trimmed)) {
      hits += 1;
    }
  }

  if (hits >= 3) {
    return true;
  }

  if (trimmed.length > 150 &&
      /^(?:The user said|The user is asking|The user is reporting|The user might be|I need to check|I should just answer|I should provide guidance|Looking at the context|Based on the)/i.test(trimmed)) {
    return true;
  }

  return false;
}

function removeInternalReasoningBlocks(text: string, traceId: string): string {
  const paragraphs = text.split(/\n{2,}/);
  const kept: string[] = [];
  let dropping = false;
  let droppedCount = 0;

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) {
      continue;
    }

    if (isVisibleCustomerReplyHeading(trimmedParagraph)) {
      dropping = false;
      continue;
    }

    if (isInternalReasoningHeading(trimmedParagraph) || startsWithInternalReasoningHeading(trimmedParagraph) || isInternalDecisionRecord(trimmedParagraph) || isLikelyInternalMonologueParagraph(trimmedParagraph) || isLikelyEnglishInternalMonologue(trimmedParagraph)) {
      dropping = true;
      droppedCount += 1;
      continue;
    }

    if (dropping) {
      if (isVisibleCustomerReplyStart(trimmedParagraph)) {
        dropping = false;
      } else {
        droppedCount += 1;
        continue;
      }
    }

    kept.push(trimmedParagraph);
  }

  if (droppedCount > 0) {
    const sanitized = kept.join("\n\n").trim();
    console.warn(`[crisp] ⚠️ Trace ${traceId} removed internal reasoning block(s) from reply (droppedParagraphs=${droppedCount}, originalChars=${text.length}, sanitizedChars=${sanitized.length})`);
    return sanitized;
  }

  return text.trim();
}

function isUsableCustomerReply(text: string): boolean {
  const normalized = text.replace(/\s+/g, "").trim();
  if (!normalized) {
    return false;
  }
  if (normalized.length <= 2) {
    return false;
  }
  if (/^(好的|好|嗯|啊|哦|收到|明白|可以|谢谢|感谢|OK|Ok|ok|Thanks|Thankyou|Sure|Hi|Hello)[。.!！~～]*$/i.test(normalized)) {
    return false;
  }
  if (/^(您好|你好|亲|亲爱的|尊敬的客户|感谢您的咨询|请稍等|我们会尽快回复|已收到您的消息)[。.!！~～]*$/i.test(normalized)) {
    return false;
  }
  if (isInternalReasoningHeading(text) || isInternalDecisionRecord(text)) {
    return false;
  }
  // Note: isLikelyInternalMonologueParagraph is too aggressive for normal customer-
  // support answers; it was dropping legitimate fallback replies.  Rely on the line
  // and block-based filters in sanitizeCustomerReply instead.
  return true;
}

function sanitizeCustomerReply(text: string, traceId: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (isInternalFailureReply(trimmed)) {
    console.warn(`[crisp] ⚠️ Trace ${traceId} suppressed internal failure reply payload`);
    return SAFE_VISIBLE_FALLBACK_MESSAGE;
  }

  const internalLinePattern = /^\s*(?:[-*]\s*)?(?:用户说|用户再次抱怨|用户抱怨|用户询问|这说明|这意味着|结合之前|根据知识库|我应该|等等|这种情况|内部判断|内部决策|转人工规则|分析|推理|思考|判断|处理思路|回复策略|Reasoning|Thinking|Decision|The user|The customer|I need|I should|I will|Final answer|Customer-facing reply)[:：]/i;

  const labeledReply = trimmed.match(/(?:最终回复|客户可见回复|回复客户|发送给客户|对客户说|Final answer|Customer-facing reply|Reply to customer)[:：]\s*([\s\S]+)$/i);
  const labeledCandidate = labeledReply?.[1]?.trim();
  if (labeledCandidate && !internalLinePattern.test(labeledCandidate)) {
    console.warn(`[crisp] ⚠️ Trace ${traceId} sanitized internal reasoning reply by extracting labeled customer-facing section (originalChars=${trimmed.length}, sanitizedChars=${labeledCandidate.length})`);
    return labeledCandidate;
  }

  const withoutReasoningBlocks = removeInternalReasoningBlocks(trimmed, traceId);
  if (!withoutReasoningBlocks) {
    return INTERNAL_REASONING_FALLBACK;
  }
  if (withoutReasoningBlocks !== trimmed) {
    if (isUsableCustomerReply(withoutReasoningBlocks)) {
      return withoutReasoningBlocks;
    }
    return INTERNAL_REASONING_FALLBACK;
  }

  const customerFacingSuffix = trimmed.match(/(?:^|\n{2,})(您好|你好|抱歉|不好意思|非常理解|理解您|可以的|建议您|请您|目前|您可以|这边|好的|收到|感谢|谢谢|Hello|Hi|Sorry|Thanks|Thank you|Please|You can)[\s\S]*$/i)?.[0]?.trim();
  if (customerFacingSuffix && customerFacingSuffix !== trimmed && customerFacingSuffix.length >= 12 && !internalLinePattern.test(customerFacingSuffix)) {
    console.warn(`[crisp] ⚠️ Trace ${traceId} sanitized internal reasoning reply by extracting customer-facing suffix (originalChars=${trimmed.length}, sanitizedChars=${customerFacingSuffix.length})`);
    return customerFacingSuffix;
  }

  const lines = trimmed.split(/\r?\n/);
  const internalLineHits = lines.filter((line) => internalLinePattern.test(line)).length;
  const startsWithInternalMarker = /^(用户说|用户再次抱怨|用户抱怨|用户询问|这说明|这意味着|结合之前|根据知识库|我应该|等等|这种情况|内部判断|内部决策|转人工规则|分析|推理|思考|判断|处理思路|回复策略|Reasoning|Thinking|Decision|The user|The customer|I need|I should|I will)[:：]/i.test(trimmed);
  const numberedInternalPlan = /(?:^|\n)\s*(?:\d+\.|[-*])\s*(?:用户|知识库|应该|需要判断|转人工|内部|the user|knowledge base|I should|I need)/i.test(trimmed);
  const explicitReasoningBlock = /(?:^|\n)\s*(?:分析|推理|思考|处理思路|回复策略|Reasoning)[:：]\s*\S[\s\S]*(?:最终回复|客户可见回复|回复客户|发送给客户|对客户说|Final answer|Customer-facing reply)[:：]/i.test(trimmed);

  // Be conservative: normal customer-support answers often contain words like
  // “判断/分析/目前”. Do not drop them unless the whole payload clearly looks like
  // an internal plan/reasoning transcript. False positives here create customer-
  // visible fallback spam, which is worse than sending a slightly imperfect answer.
  if (explicitReasoningBlock || internalLineHits >= 2 || (startsWithInternalMarker && numberedInternalPlan)) {
    console.warn(`[crisp] ⚠️ Trace ${traceId} suppressed internal reasoning reply (originalChars=${trimmed.length}, internalLineHits=${internalLineHits})`);
    return INTERNAL_REASONING_FALLBACK;
  }

  // Hard guard: English model monologue that leaked through core reasoning filtering.
  if (isLikelyEnglishInternalMonologue(trimmed)) {
    console.warn(`[crisp] ⚠️ Trace ${traceId} suppressed English model internal monologue (The user said/Looking at the context/I should)`);
    return INTERNAL_REASONING_FALLBACK;
  }

  // Hard guard: Chinese model paraphrasing/reasoning that starts with "用户反馈" or "用户问：" or "客户问：" or contains "这通常是"
  if (/^\s*(?:用户反馈|客户反馈|用户说|用户再次抱怨|用户抱怨|用户问[：:]|用户问[：:]"|客户问[：:]|客户问[：:]"|用户询问的是|用户问的是|用户询问|用户问)[\s\S]{0,300}/i.test(trimmed) ||
      /^\s*(?:这通常是|这显然是|这往往是|一般来说这|一般是|这种情况通常|这属于|这意味着|这看起来是|该问题通常|该情况通常|此类问题通常|结合之前|用户情绪)[\s\S]{0,300}/i.test(trimmed)) {
    console.warn(`[crisp] ⚠️ Trace ${traceId} suppressed Chinese model paraphrase/reasoning (用户反馈/用户问/这通常是)`);
    return INTERNAL_REASONING_FALLBACK;
  }

  if (!isUsableCustomerReply(trimmed)) {
    console.warn(`[crisp] ⚠️ Trace ${traceId} suppressed unusable customer reply payload (originalChars=${trimmed.length})`);
    return SAFE_VISIBLE_FALLBACK_MESSAGE;
  }

  // Aggressive heuristic for Kimi-style monologue summaries that repeat the user question and then cite knowledge-base rules.
  if (/(?:用户询问的是|用户问的是|用户询问|用户问)[：:]?\s*[\s\S]+?根据知识库[\s\S]{0,200}?所以答案是/i.test(trimmed) ||
      /(?:用户询问的是|用户问的是|用户询问|用户问)[：:]?\s*[\s\S]+?根据知识库[\s\S]{0,500}?\n(?:[\s\S]*?\n)?(?:所以|因此|综上|结论[:：]|Answer[:：]|Final answer[:：])/i.test(trimmed) ||
      /^\s*根据知识库中的规则[:：]/i.test(trimmed) ||
      /(?:这是一个标准问题|直接回答即可|无需特殊处理|按规则处理)/i.test(trimmed)) {
    console.warn(`[crisp] ⚠️ Trace ${traceId} suppressed Kimi-style internal summary (repeats user question + knowledge-base rules)`);
    return INTERNAL_REASONING_FALLBACK;
  }

  // Heuristic for English model reasoning that paraphrases the user's message and then describes what kind of response is appropriate.
  if (/(?:The user's latest message is|The user is saying|This is a brief acknowledgment from the user|There's no new question or issue to address|A brief,? [\w\s]+ response is appropriate|is appropriate here|I should respond with|I will respond with|I should keep)/i.test(trimmed)) {
    console.warn(`[crisp] ⚠️ Trace ${traceId} suppressed English model reasoning/paraphrase`);
    return INTERNAL_REASONING_FALLBACK;
  }

  // Suppress any remaining OpenClaw internal meta / fallback status messages.
  const internalMetaPattern = /^(?:↪️\s*)?(?:Model Fallback|Fallback|selected\s+[\w\/._-]+\s*[:;]|\(?[\w\s\/]+timeout\)?)/i;
  if (internalMetaPattern.test(trimmed)) {
    console.warn(`[crisp] ⚠️ Trace ${traceId} suppressed internal meta/fallback status message`);
    return SAFE_VISIBLE_FALLBACK_MESSAGE;
  }
  if (/↪️\s*Model Fallback/i.test(trimmed)) {
    console.warn(`[crisp] ⚠️ Trace ${traceId} suppressed OpenClaw fallback notice`);
    return SAFE_VISIBLE_FALLBACK_MESSAGE;
  }

  return trimmed;
}

/**
 * Send a reply to a Crisp conversation (used after approval)
 */
export async function sendCrispReply(
  config: CrispConfig,
  sessionId: string,
  websiteId: string,
  message: string
): Promise<{ ok: boolean; error?: string }> {
  const client = createCrispClient({
    apiKeyId: config.apiKeyId,
    apiKeySecret: config.apiKeySecret,
  });

  try {
    await client.sendMessage({
      websiteId,
      sessionId,
      content: message,
    });
    console.log(`[crisp] ✅ Sent reply to ${sessionId}`);
    
    if (config.resolveOnReply) {
      await client.updateConversationState(websiteId, sessionId, "resolved");
    }
    
    return { ok: true };
  } catch (err) {
    console.error(`[crisp] ❌ Failed to send reply:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function storePendingReplyAndNotify(params: {
  config: CrispConfig;
  core: ReturnType<typeof getCrispRuntime>;
  route: { sessionKey: string };
  accountId: string;
  sessionId: string;
  websiteId: string;
  visitorName: string;
  messageText: string;
  mediaUrl?: string;
}): Promise<void> {
  const { config, core, route, accountId, sessionId, websiteId, visitorName, messageText, mediaUrl } = params;

  const pending = storePendingReply({
    crispSessionId: sessionId,
    crispWebsiteId: websiteId,
    visitorName,
    visitorMessage: messageText,
    proposedReply: "",
    mediaUrl,
    accountId,
    crispApiKeyId: config.apiKeyId,
    crispApiKeySecret: config.apiKeySecret,
    resolveOnReply: config.resolveOnReply,
    siteName: config.name || websiteId,
  });

  console.log(`[crisp] 📋 Stored pending message [${pending.id}]`);
  console.log(`[crisp] 👤 From: ${visitorName}`);
  console.log(`[crisp] 💬 Message: "${messageText}"`);

  if (config.telegramBotToken && config.approvalChatId) {
    try {
      const result = await sendTelegramNotification({
        botToken: config.telegramBotToken,
        chatId: config.approvalChatId,
        threadId: config.approvalThreadId ?? config.approvalTopicId,
        pendingId: pending.id,
        siteName: config.name || websiteId,
        visitorName,
        visitorMessage: messageText,
        mediaUrl,
      });

      if (result.ok && result.messageId) {
        console.log(`[crisp] 📱 Telegram notification sent (msg ${result.messageId})`);
        updatePendingReplyTelegram(
          pending.id,
          String(result.messageId),
          config.approvalChatId,
          config.approvalThreadId ?? config.approvalTopicId ? String(config.approvalThreadId ?? config.approvalTopicId) : undefined,
          config.telegramBotToken,
        );
      } else {
        console.error(`[crisp] ❌ Telegram notification failed: ${result.error}`);
      }
    } catch (err) {
      console.error(`[crisp] ❌ Failed to send Telegram notification:`, err);
    }
    return;
  }

  console.log(`[crisp] ⚠️ Telegram not configured, skipping notification`);
  try {
    core.system.enqueueSystemEvent(
      `🆕 CRISP_MESSAGE [${pending.id}] from "${visitorName}": "${messageText}"`,
      {
        sessionKey: route.sessionKey,
        contextKey: `crisp:pending:${pending.id}`,
      }
    );
    console.log(`[crisp] 📤 System event emitted for [${pending.id}]`);
  } catch (err) {
    console.error(`[crisp] ❌ Failed to emit system event:`, err);
  }
}

async function deleteLocalInboundImage(params: { localPath: string; traceId: string; reason: string }): Promise<void> {
  const { localPath, traceId, reason } = params;
  try {
    await fs.unlink(localPath);
    console.log(`[crisp] 🧹 Trace ${traceId} deleted local inbound image (${reason}) path=${localPath}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn(`[crisp] ⚠️ Trace ${traceId} failed to delete local inbound image (${reason}) path=${localPath}: ${err}`);
    }
  }
}

function scheduleInboundImageCleanup(localPath: string, traceId: string): void {
  const timeout = setTimeout(() => {
    void deleteLocalInboundImage({
      localPath,
      traceId,
      reason: "retention-expired",
    });
  }, INBOUND_IMAGE_LOCAL_RETENTION_MS);
  timeout.unref?.();
}

async function sweepStaleInboundImages(localPath: string, traceId: string): Promise<void> {
  const dir = path.dirname(localPath);
  const cutoff = Date.now() - INBOUND_IMAGE_STALE_SWEEP_RETENTION_MS;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    console.warn(`[crisp] ⚠️ Trace ${traceId} stale inbound image sweep skipped dir=${dir}: ${err}`);
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(dir, entry);
    if (candidate === localPath) {
      return;
    }
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) {
        return;
      }
      await fs.unlink(candidate);
      console.log(`[crisp] 🧹 Trace ${traceId} swept stale inbound image path=${candidate}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        console.warn(`[crisp] ⚠️ Trace ${traceId} failed stale inbound image sweep path=${candidate}: ${err}`);
      }
    }
  }));
}

async function prepareInboundImageMedia(params: {
  core: ReturnType<typeof getCrispRuntime>;
  mediaUrl: string | undefined;
  traceId: string;
}): Promise<PreparedInboundMedia | undefined> {
  const { core, mediaUrl, traceId } = params;
  const originalUrl = mediaUrl?.trim();
  if (!originalUrl) {
    return undefined;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(originalUrl);
  } catch {
    console.warn(`[crisp] ⚠️ Trace ${traceId} inbound media skipped: invalid URL`);
    return { originalUrl };
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    console.warn(`[crisp] ⚠️ Trace ${traceId} inbound media skipped: unsupported protocol`);
    return { originalUrl };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INBOUND_IMAGE_FETCH_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const response = await fetch(originalUrl, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: "image/*",
      },
    });

    if (!response.ok) {
      console.warn(`[crisp] ⚠️ Trace ${traceId} inbound media download failed status=${response.status}`);
      return { originalUrl };
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!contentType?.startsWith("image/")) {
      console.warn(`[crisp] ⚠️ Trace ${traceId} inbound media skipped: non-image contentType=${contentType ?? "-"}`);
      return { originalUrl };
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_INBOUND_IMAGE_BYTES) {
      console.warn(`[crisp] ⚠️ Trace ${traceId} inbound media skipped: contentLength=${contentLength} exceeds max=${MAX_INBOUND_IMAGE_BYTES}`);
      return { originalUrl, contentType, sizeBytes: contentLength };
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (!reader) {
      console.warn(`[crisp] ⚠️ Trace ${traceId} inbound media skipped: response body unavailable`);
      return { originalUrl, contentType };
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_INBOUND_IMAGE_BYTES) {
        controller.abort();
        console.warn(`[crisp] ⚠️ Trace ${traceId} inbound media download aborted: bytes=${totalBytes} exceeds max=${MAX_INBOUND_IMAGE_BYTES}`);
        return { originalUrl, contentType, sizeBytes: totalBytes };
      }
      chunks.push(Buffer.from(value));
    }

    if (totalBytes === 0) {
      console.warn(`[crisp] ⚠️ Trace ${traceId} inbound media skipped: empty image body`);
      return { originalUrl, contentType, sizeBytes: 0 };
    }

    const buffer = Buffer.concat(chunks, totalBytes);
    const saved = await core.channel.media.saveMediaBuffer(
      buffer,
      contentType,
      "inbound",
      MAX_INBOUND_IMAGE_BYTES
    );

    console.log(`[crisp] 🖼️ Trace ${traceId} inbound image saved for agent media path=${saved.path} contentType=${saved.contentType ?? contentType} bytes=${totalBytes}`);
    scheduleInboundImageCleanup(saved.path, traceId);
    void sweepStaleInboundImages(saved.path, traceId);
    return {
      originalUrl,
      localPath: saved.path,
      contentType: saved.contentType ?? contentType,
      sizeBytes: totalBytes,
    };
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.warn(`[crisp] ⚠️ Trace ${traceId} inbound media download unavailable: ${detail}`);
    return { originalUrl };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Handle inbound message from Crisp
 */
function isSessionProcessingLocked(sessionKey: string): boolean {
  return sessionProcessingLocks.has(sessionKey);
}

async function runWithSessionProcessingLock(
  sessionKey: string,
  fn: () => Promise<void>
): Promise<void> {
  const previous = sessionProcessingLocks.get(sessionKey);
  const waitStartedAt = Date.now();
  if (previous) {
    console.log(`[crisp] ⏳ Session lock wait: ${sessionKey}`);
    try {
      await previous;
      console.log(`[crisp] ⏳ Session lock acquired after wait: ${sessionKey} waitMs=${Date.now() - waitStartedAt}`);
    } catch {
      console.log(`[crisp] ⏳ Session lock wait ended after prior failure: ${sessionKey} waitMs=${Date.now() - waitStartedAt}`);
      // Ignore prior task failure; current task still gets a chance.
    }
  } else {
    console.log(`[crisp] ⏳ Session lock immediate acquire: ${sessionKey}`);
  }

  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionProcessingLocks.set(sessionKey, current);

  try {
    await fn();
  } finally {
    release();
    if (sessionProcessingLocks.get(sessionKey) === current) {
      sessionProcessingLocks.delete(sessionKey);
    }
    console.log(`[crisp] 🔓 Session lock internal release: ${sessionKey}`);
  }
}

const CRISP_INBOUND_DEBOUNCE_MS = 3000;
const crispInboundBuffers = new Map<string, {
  entries: Array<{
    config: CrispConfig;
    clawdbotConfig: ClawdbotConfig;
    accountId: string;
    trigger: "webhook" | "sweeper";
    inbound: BufferedInboundMessage;
  }>;
  timeout: NodeJS.Timeout | null;
}>();

function buildCrispDebounceKey(params: { accountId: string; inbound: BufferedInboundMessage }): string {
  return `crisp:${params.accountId}:${params.inbound.websiteId}:${params.inbound.sessionId}`;
}

async function flushCrispInboundBuffer(key: string): Promise<void> {
  const buffer = crispInboundBuffers.get(key);
  if (!buffer) return;
  crispInboundBuffers.delete(key);
  if (buffer.timeout) {
    clearTimeout(buffer.timeout);
  }

  const entries = buffer.entries;
  const last = entries.at(-1);
  if (!last) return;

  try {
    if (entries.length === 1) {
      await processInboundMessage(last);
      return;
    }

    const mergedContents = entries
      .map((entry) => entry.inbound.content?.trim())
      .filter((value): value is string => Boolean(value));

    const mergedInbound: BufferedInboundMessage = {
      ...last.inbound,
      content: mergedContents.join("\n"),
      sourceCount: entries.length,
      sourceMessageKeys: entries.flatMap((entry) => entry.inbound.sourceMessageKeys ?? [buildInboundMessageKey({
        fingerprint: entry.inbound.fingerprint,
        timestampMs: entry.inbound.timestampMs,
        type: entry.inbound.type,
        content: entry.inbound.content,
      })]),
      sourceFingerprints: entries.map((entry) => entry.inbound.fingerprint),
    };

    console.log(`[crisp] 🧩 Debounced ${entries.length} inbound messages into one session=${mergedInbound.sessionId} website=${mergedInbound.websiteId}`);

    await processInboundMessage({
      ...last,
      inbound: mergedInbound,
    });
  } catch (err) {
    console.error(
      `[crisp] ❌ Debounce flush failed session=${last.inbound.sessionId} website=${last.inbound.websiteId}:`,
      err
    );
  }
}

export async function flushCrispInboundDebounceForTests(): Promise<void> {
  const keys = [...crispInboundBuffers.keys()];
  for (const key of keys) {
    await flushCrispInboundBuffer(key);
  }
}

async function enqueueCrispInbound(params: {
  config: CrispConfig;
  clawdbotConfig: ClawdbotConfig;
  accountId: string;
  trigger: "webhook" | "sweeper";
  inbound: BufferedInboundMessage;
}): Promise<void> {
  const shouldDebounce = process.env.VITEST !== "true" && params.trigger === "webhook" && params.inbound.type === "text" && Boolean(params.inbound.content.trim());
  const key = buildCrispDebounceKey({ accountId: params.accountId, inbound: params.inbound });

  if (!shouldDebounce) {
    const existing = crispInboundBuffers.get(key);
    if (existing) {
      await flushCrispInboundBuffer(key);
    }
    await processInboundMessage(params);
    return;
  }

  const existing = crispInboundBuffers.get(key);
  if (existing) {
    existing.entries.push(params);
    if (existing.timeout) {
      clearTimeout(existing.timeout);
    }
    existing.timeout = setTimeout(() => {
      void flushCrispInboundBuffer(key);
    }, CRISP_INBOUND_DEBOUNCE_MS);
    existing.timeout.unref?.();
    return;
  }

  const timeout = setTimeout(() => {
    void flushCrispInboundBuffer(key);
  }, CRISP_INBOUND_DEBOUNCE_MS);
  timeout.unref?.();
  crispInboundBuffers.set(key, {
    entries: [params],
    timeout,
  });
}

async function processInboundMessage(params: {
  config: CrispConfig;
  clawdbotConfig: ClawdbotConfig;
  accountId: string;
  inbound: BufferedInboundMessage;
  trigger: "webhook" | "sweeper";
}): Promise<void> {
  const { config, clawdbotConfig, accountId, inbound, trigger } = params;
  const sessionId = inbound.sessionId;
  const traceId = `${trigger}:${sessionId}:${Date.now().toString(36)}`;
  const isFile = inbound.type === "file";
  const messageText = isFile ? "图片" : inbound.content;
  const mediaUrl = isFile ? inbound.content : undefined;
  const managedSessionKey = {
    accountId,
    websiteId: inbound.websiteId,
    sessionId,
  };
  const processingKey = buildTrackedSessionKey(accountId, inbound.websiteId, sessionId);
  const inboundMessageKey = buildInboundMessageKey({
    fingerprint: inbound.fingerprint,
    timestampMs: inbound.timestampMs,
    type: inbound.type,
    content: inbound.content,
  });
  const aggregatedMessageKeys = inbound.sourceMessageKeys?.length
    ? [...new Set(inbound.sourceMessageKeys)]
    : [inboundMessageKey];

  await runWithSessionProcessingLock(processingKey, async () => {
    const handlerStartedAt = Date.now();
    console.log(`[crisp] ${trigger === "sweeper" ? "🧹" : "🪝"} Trigger=${trigger} session=${sessionId} website=${inbound.websiteId} messageKey=${inboundMessageKey} sourceCount=${inbound.sourceCount ?? 1}`);
    console.log(`[crisp] 📩 Message from ${inbound.visitorName}: "${messageText}"`);
    console.log(`[crisp] Session: ${sessionId}, Website: ${inbound.websiteId}`);
    console.log(`[crisp] 🔎 Trace ${traceId} start inbound handling timestampMs=${inbound.timestampMs} fingerprint=${inbound.fingerprint ?? "-"} aggregatedKeys=${aggregatedMessageKeys.length}`);

    const session = trackSession(
      sessionId,
      inbound.websiteId,
      accountId,
      inbound.visitorName,
      undefined
    );

    if (session.isNew) {
      console.log(`[crisp] 🆕 New conversation started`);
      if (isGlobalAutoModeEnabled()) {
        markManagedSession(managedSessionKey);
        console.log(`[crisp] 🤖 Global auto mode: defaulting new conversation ${sessionId} to managed mode`);
      }
    }

    if (!config.autoReply && !config.approvalMode) {
      console.log(`[crisp] Auto-reply disabled, message logged only`);
      return;
    }

    if (!hasCrispRuntime()) {
      console.error(`[crisp] ❌ Runtime not available`);
      return;
    }

    const core = getCrispRuntime();
    const client = createCrispClient({
      apiKeyId: config.apiKeyId,
      apiKeySecret: config.apiKeySecret,
    });

    const markCurrentMessageProcessed = (): void => {
      for (const key of aggregatedMessageKeys) {
        markProcessedMessage({
          sessionKey: processingKey,
          messageKey: key,
          source: trigger,
        });
      }
    };

    const sendTextToCrisp = async (params: {
      content: string;
      markProcessed?: boolean;
      logPrefix: string;
    }): Promise<boolean> => {
      const rawText = params.content.trim();
      const text = rawText ? sanitizeCustomerReply(rawText, traceId).trim() : rawText;
      if (!text) {
        console.warn(`[crisp] ⚠️ ${params.logPrefix} skipped empty text payload`);
        return false;
      }
      if (isInternalFailureReply(text) || !isUsableCustomerReply(text)) {
        console.warn(`[crisp] ⚠️ ${params.logPrefix} suppressed unusable text payload`);
        return false;
      }
      console.log(`[crisp] 🔎 ${params.logPrefix} sending message to Crisp (chars=${text.length})`);
      try {
        const sendResult = await client.sendMessage({
          websiteId: inbound.websiteId,
          sessionId,
          content: text,
        });
        if (params.markProcessed !== false) {
          markCurrentMessageProcessed();
        }
        console.log(`[crisp] ✅ ${params.logPrefix} sent to ${sessionId} (fingerprint=${sendResult.fingerprint}, type=${sendResult.type ?? "-"}, from=${sendResult.from ?? "-"}, origin=${sendResult.origin ?? "-"}, echoedContent=${JSON.stringify(sendResult.content ?? "")})`);
        return true;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const sessionMissing = /session_not_found|404\s+Not Found/i.test(detail);
        console.error(`[crisp] ❌ ${params.logPrefix} send failed sessionMissing=${sessionMissing}: ${detail}`);
        if (sessionMissing) {
          console.warn(`[crisp] ⚠️ ${params.logPrefix} treating missing Crisp session as terminal send failure (no retry via fallback)`);
        }
        throw err;
      }
    };

    const sendManagedModeFeedback = async (content: string): Promise<void> => {
      await sendTextToCrisp({
        content,
        logPrefix: `Trace ${traceId} managed-mode-feedback`,
      });
    };

    if (!isFile && isManagedModeEnableCommand(messageText)) {
      markManagedSession(managedSessionKey);
      console.log(`[crisp] 🫴 Managed mode enabled for session ${sessionId}`);
      await sendManagedModeFeedback("已开启托管模式。后续消息默认由 AI 托管，不再转发到人工通知；如需人工协助，请发送“人工”。");
      return;
    }

    if (!isFile && isManagedModeDisableCommand(messageText)) {
      const wasManaged = releaseManagedSession(managedSessionKey);
      console.log(`[crisp] ↩️ Managed mode ${wasManaged ? "disabled" : "already off"} for session ${sessionId}`);
      await sendManagedModeFeedback(
        wasManaged
          ? "已关闭托管模式。后续消息将恢复转发到人工通知。"
          : "当前未处于托管模式。后续消息仍会按原流程处理。"
      );
      return;
    }

    const normalizedMessageText = mediaUrl ? "图片" : messageText;
    const isSessionManaged = isManagedSession(managedSessionKey);
    const needsHumanHandoff = isHumanHandoffMessage(normalizedMessageText);
    const isHumanPaused = isHumanPauseSession(managedSessionKey);

    if (isIgnoredSession(managedSessionKey)) {
      console.log(`[crisp] 🔕 Ignored session ${sessionId}: suppressing approval forwarding and AI reply`);
      markCurrentMessageProcessed();
      return;
    }

    if (isHumanPaused) {
      const remainingMs = getHumanPauseRemainingMs(managedSessionKey);
      console.log(
        `[crisp] ⏸️ Human pause active for ${sessionId}, remaining=${Math.ceil(remainingMs / 1000)}s, skipping AI reply`
      );
      if (!needsHumanHandoff) {
        console.log(`[crisp] ⏸️ Human pause: non-keyword follow-up suppressed during human pause without AI reply or Telegram notification`);
        markCurrentMessageProcessed();
        return;
      }
    }

    const preparedMedia = await prepareInboundImageMedia({
      core,
      mediaUrl,
      traceId,
    });
    const agentMediaPath = preparedMedia?.localPath;
    const agentMediaContentType = preparedMedia?.contentType;

    let historyText = "";
    if (config.historyLimit > 0) {
      try {
        console.log(`[crisp] 🔎 Trace ${traceId} fetching history (limit=${config.historyLimit})`);
        const messages = await client.getMessages(
          inbound.websiteId,
          sessionId,
          { limit: config.historyLimit }
        );
        const chronologicalMessages = messages.reverse();
        const historyMessages = chronologicalMessages
          .slice(0, -1)
          .slice(Math.max(0, chronologicalMessages.length - 1 - config.historyLimit));
        const history = historyMessages
          .map((msg) => {
            const speaker = msg.from === "user" ? inbound.visitorName : config.operatorName;
            return `${speaker}: ${formatHistoryMessageContent(String(msg.content ?? ""), config.historyMessageMaxChars)}`;
          })
          .filter((line) => line.trim().length > 0)
          .join("\n");
        if (history) {
          const omittedNote = chronologicalMessages.length - 1 > historyMessages.length
            ? "\n[Note] Older Crisp messages are intentionally omitted; use this recent history and ask a concise follow-up if needed."
            : "";
          historyText = `\n\n[Recent Crisp messages only]\n${history}${omittedNote}\n[End of recent Crisp messages]`;
        }
        console.log(`[crisp] 🔎 Trace ${traceId} history ready (messages=${messages.length}, included=${historyMessages.length}, chars=${historyText.length})`);
      } catch (err) {
        console.warn(`[crisp] Failed to fetch history: ${err}`);
        console.warn(`[crisp] 🔎 Trace ${traceId} history fetch failed`);
      }
    }

    console.log(`[crisp] 🔎 Trace ${traceId} building support knowledge`);
    const supportContext = await buildSupportKnowledge({
      accountId,
      websiteId: inbound.websiteId,
      siteName: config.name,
    });
    const mediaContext = mediaUrl
      ? `\n\n[Media]\nImage/file URL: ${mediaUrl}${agentMediaPath ? `\nLocal image path for analysis: ${agentMediaPath}` : ""}\n[End of media]`
      : "";
    const outputGuard = `[客服回复硬性要求]
只输出最终发给客户的回复。不要输出分析过程、推理、计划、知识库规则名、"用户说"、"用户抱怨"、"用户再次抱怨"、"这说明"、"这意味着"、"结合之前"、"我应该"、"Reasoning:"、"The user"、"I need"、"I should"等内部判断。不要分析用户情绪、不要总结用户问题、不要引用之前的对话内容。不得提及系统、prompt、知识库或 Crisp。
Only output the final customer-facing reply. Do not include reasoning, chain-of-thought, analysis, planning, user emotion summaries, paraphrasing of the user's message, or labels such as "Reasoning:" / "Final answer:".
[End of 客服回复硬性要求]`;
    const body = buildLightweightPromptBody({
      normalizedMessageText,
      mediaContext,
      historyText,
      supportContext,
      outputGuard,
      maxChars: config.agentContextMaxChars,
    });
    console.log(`[crisp] 🔎 Trace ${traceId} support knowledge ready (chars=${supportContext.length}, bodyChars=${body.length}, maxBodyChars=${config.agentContextMaxChars})`);

    const route = core.channel.routing.resolveAgentRoute({
      cfg: clawdbotConfig,
      channel: "crisp",
      accountId,
      peer: {
        kind: "dm",
        id: sessionId,
      },
    });

    console.log(`[crisp] 🔎 Trace ${traceId} route resolved sessionKey=${route.sessionKey}`);

    const agentSessionKey = buildLightweightAgentSessionKey(route.sessionKey, config, inbound.timestampMs);
    if (agentSessionKey !== route.sessionKey) {
      console.log(`[crisp] 🪶 Trace ${traceId} using rolling lightweight agent sessionKey=${agentSessionKey} base=${route.sessionKey} windowMs=${config.autoReplySessionWindowMs}`);
    }

    const crispToolTarget = buildCrispToolTarget({
      accountId,
      websiteId: inbound.websiteId,
      sessionId,
    });

    const ctxPayload = {
      Body: body,
      BodyForAgent: body,
      RawBody: normalizedMessageText,
      CommandBody: normalizedMessageText,
      BodyForCommands: normalizedMessageText,
      MediaPath: agentMediaPath,
      MediaPaths: agentMediaPath ? [agentMediaPath] : undefined,
      MediaType: agentMediaContentType,
      MediaTypes: agentMediaContentType ? [agentMediaContentType] : undefined,
      MediaUrl: agentMediaPath ?? mediaUrl,
      MediaUrls: agentMediaPath ? [agentMediaPath] : mediaUrl ? [mediaUrl] : undefined,
      OriginalMediaUrl: mediaUrl,
      From: crispToolTarget,
      To: crispToolTarget,
      SessionKey: agentSessionKey,
      AccountId: accountId,
      CrispAccountId: accountId,
      CrispWebsiteId: inbound.websiteId,
      CrispSessionId: sessionId,
      DeliveryTarget: crispToolTarget,
      ChatType: "direct",
      ConversationLabel: inbound.visitorName,
      SenderName: inbound.visitorName,
      SenderId: sessionId,
      Provider: "crisp",
      Surface: "crisp",
      MessageSid: inbound.fingerprint?.toString(),
      Timestamp: inbound.timestampMs,
      OriginatingChannel: "crisp",
      OriginatingTo: crispToolTarget,
      WasMentioned: true,
      CommandAuthorized: true,
    };

    if (isHumanPaused) {
      console.log(`[crisp] 🔄 Human pause: human-handoff keyword detected, storing for human review without AI reply...`);
      await storePendingReplyAndNotify({
        config,
        core,
        route,
        accountId,
        sessionId,
        websiteId: inbound.websiteId,
        visitorName: inbound.visitorName,
        messageText: normalizedMessageText,
        mediaUrl,
      });
      markCurrentMessageProcessed();
      return;
    }

    if (config.approvalMode && !isSessionManaged) {
      if (needsHumanHandoff) {
        console.log(`[crisp] 🔄 Approval mode: human-handoff keyword detected, storing for human review...`);
        await storePendingReplyAndNotify({
          config,
          core,
          route,
          accountId,
          sessionId,
          websiteId: inbound.websiteId,
          visitorName: inbound.visitorName,
          messageText: normalizedMessageText,
          mediaUrl,
        });
        markCurrentMessageProcessed();
        return;
      }

      console.log(`[crisp] 🔄 Approval mode with auto-reply: non-keyword message, continuing to AI auto-reply for ${sessionId}`);
    }

    if (isSessionManaged) {
      if (needsHumanHandoff) {
        console.log(`[crisp] 🧑‍💼 Managed session: human-handoff keyword detected, but keeping AI auto-reply on and still notifying Telegram`);
        await storePendingReplyAndNotify({
          config,
          core,
          route,
          accountId,
          sessionId,
          websiteId: inbound.websiteId,
          visitorName: inbound.visitorName,
          messageText: normalizedMessageText,
          mediaUrl,
        });
      }
      console.log(`[crisp] 🫴 Managed session: suppressing approval forwarding and using auto-reply`);
    }

    const autoReplyMaxConcurrent = resolveAutoReplyMaxConcurrent(config.autoReplyMaxConcurrent);
    const queueDepthBeforeAcquire = getAutoReplyQueueDepth(accountId);
    if ((activeAutoRepliesByAccount.get(accountId) ?? 0) >= autoReplyMaxConcurrent) {
      console.warn(`[crisp] 🚦 Trace ${traceId} auto-reply concurrency limit reached for account=${accountId} limit=${autoReplyMaxConcurrent}; queued behind ${queueDepthBeforeAcquire} pending auto-replies waitTimeoutMs=${config.autoReplySlotWaitTimeoutMs}`);
    }
    const releaseAutoReplySlot = await acquireAutoReplySlot(accountId, autoReplyMaxConcurrent, config.autoReplySlotWaitTimeoutMs);
    if (!releaseAutoReplySlot) {
      console.warn(`[crisp] 🚦 Trace ${traceId} auto-reply slot wait timed out after ${config.autoReplySlotWaitTimeoutMs}ms; routing to human review instead of sending customer fallback`);
      await storePendingReplyAndNotify({
        config,
        core,
        route,
        accountId,
        sessionId,
        websiteId: inbound.websiteId,
        visitorName: inbound.visitorName,
        messageText: normalizedMessageText,
        mediaUrl,
      });
      markCurrentMessageProcessed();
      console.log(`[crisp] 🔎 Trace ${traceId} end inbound handling elapsedMs=${Date.now() - handlerStartedAt} sentReply=false queueTimedOut=true humanReview=true`);
      console.log(`[crisp] 🔓 Session lock release: ${processingKey}`);
      return;
    }

    let sentReply = false;
    let nonEmptyDeliverCount = 0;
    let emptyDeliverCount = 0;
    let dispatchErrored = false;
    let dispatchTimedOut = false;
    const hasRepliedRef = { value: false };

    try {
      console.log(`[crisp] 🔎 Trace ${traceId} dispatch start (timeoutMs=${config.autoReplyTimeoutMs}, accountActiveLimit=${autoReplyMaxConcurrent})`);

      const dispatchPromise = core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: clawdbotConfig,
        dispatcherOptions: {
          deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }) => {
            console.log(`[crisp] 🔎 Trace ${traceId} deliver invoked (hasText=${Boolean(payload.text?.trim())}, mediaUrls=${payload.mediaUrls?.length ?? 0}, mediaUrl=${payload.mediaUrl ? 1 : 0})`);
            if (dispatchTimedOut && sentReply) {
              console.warn(`[crisp] ⚠️ Trace ${traceId} skipping late deliver after timeout fallback`);
              return;
            }
            const rawText = payload.text?.trim();
            const text = rawText ? sanitizeCustomerReply(rawText, traceId) : rawText;
            if (!text) {
              emptyDeliverCount += 1;
              console.warn(`[crisp] ⚠️ Trace ${traceId} empty deliver payload (#${emptyDeliverCount})`);
              return;
            }
            if (isInternalFailureReply(text)) {
              emptyDeliverCount += 1;
              console.warn(`[crisp] ⚠️ Trace ${traceId} suppressing internal failure deliver payload (#${emptyDeliverCount})`);
              if (!sentReply) {
                dispatchErrored = true;
              }
              return;
            }
            if (!isUsableCustomerReply(text)) {
              emptyDeliverCount += 1;
              console.warn(`[crisp] ⚠️ Trace ${traceId} suppressing unusable deliver payload (#${emptyDeliverCount})`);
              return;
            }

            if (sentReply) {
              emptyDeliverCount += 1;
              console.warn(`[crisp] ⚠️ Trace ${traceId} suppressing duplicate deliver after successful reply (#${emptyDeliverCount})`);
              return;
            }

            nonEmptyDeliverCount += 1;
            const delivered = await sendTextToCrisp({
              content: text,
              logPrefix: `Trace ${traceId} deliver#${nonEmptyDeliverCount}`,
            });
            if (!delivered) {
              emptyDeliverCount += 1;
              nonEmptyDeliverCount -= 1;
              console.warn(`[crisp] ⚠️ Trace ${traceId} deliver filtered before send (#${emptyDeliverCount})`);
              return;
            }
            sentReply = true;
            console.log(`[crisp] ✅ Sent AI reply to ${sessionId} (nonEmptyDeliverCount=${nonEmptyDeliverCount})`);
            console.log(`[crisp] 🔎 Trace ${traceId} deliver complete`);

            if (config.resolveOnReply) {
              console.log(`[crisp] ⚠️ resolveOnReply is enabled for ${sessionId}, but auto-managed replies will stay open to allow follow-up messages`);
            }
          },
          onError: (err: unknown) => {
            dispatchErrored = true;
            const errorDetail = err instanceof Error
              ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ""}`
              : typeof err === "string"
                ? err
                : JSON.stringify(err, null, 2);
            console.error(`[crisp] ❌ Reply dispatch error: ${errorDetail}`);
            console.error(`[crisp] 🔎 Trace ${traceId} onError invoked`);
          },
        },
        replyOptions: {
          hasRepliedRef,
          // Keep the underlying OpenClaw agent attempt just under the Crisp-facing
          // fallback timeout. 12s was too aggressive in production: valid customer
          // replies were killed early, then converted into internal failure payloads
          // and suppressed. Leave a small delivery buffer before the outer timeout.
          timeoutOverrideSeconds: Math.max(1, Math.ceil(Math.max(1000, config.autoReplyTimeoutMs - 5000) / 1000)),
        },
      });

      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          dispatchTimedOut = true;
          reject(new Error(`Crisp auto-reply timed out after ${config.autoReplyTimeoutMs}ms`));
        }, config.autoReplyTimeoutMs);
      });

      await Promise.race([dispatchPromise, timeoutPromise]);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      console.log(`[crisp] 🔎 Trace ${traceId} dispatch complete (sentReply=${sentReply}, hasRepliedRef=${hasRepliedRef.value}, nonEmptyDeliverCount=${nonEmptyDeliverCount}, emptyDeliverCount=${emptyDeliverCount}, dispatchErrored=${dispatchErrored}, elapsedMs=${Date.now() - handlerStartedAt})`);

      if (!sentReply && hasRepliedRef.value) {
        sentReply = true;
        console.log(`[crisp] 🔎 Trace ${traceId} direct channel/tool reply detected; skipping no-valid-deliver fallback`);
      }
      if (!sentReply) {
        const recentOperatorReply = getRecentOperatorReplySince(processingKey, handlerStartedAt - 1000);
        if (recentOperatorReply) {
          sentReply = true;
          console.log(`[crisp] 🔎 Trace ${traceId} observed operator reply webhook during dispatch; skipping no-valid-deliver fallback fingerprint=${recentOperatorReply.fingerprint ?? "-"} ageMs=${Date.now() - recentOperatorReply.at}`);
        }
      }

      if (!sentReply) {
        const noValidDeliverReason = dispatchErrored ? "dispatch-error-no-valid-deliver" : "dispatch-complete-no-valid-deliver";
        console.warn(`[crisp] ⚠️ Trace ${traceId} dispatch finished without valid deliver (${noValidDeliverReason})`);

        const fallbackText = dispatchErrored
          ? resolveSafeFallbackMessage(config.autoReplyDispatchErrorMessage)
          : resolveSafeFallbackMessage(config.autoReplyNoValidDeliverMessage);
        const fallbackLabel = dispatchErrored ? "dispatch-error-fallback" : "no-valid-deliver-fallback";
        const shouldFallback = dispatchErrored || nonEmptyDeliverCount === 0;
        const latestProcessedState = getProcessedMessageState(processingKey, inboundMessageKey);

        if (shouldFallback) {
          if (latestProcessedState) {
            console.log(`[crisp] 🔎 Trace ${traceId} ${fallbackLabel} skipped: message already marked processed source=${latestProcessedState.source} processedAt=${new Date(latestProcessedState.processedAt).toISOString()} ageMs=${Date.now() - latestProcessedState.processedAt}`);
          } else {
            if (!fallbackText) {
              console.log(`[crisp] 🛟 Trace ${traceId} ${fallbackLabel} has no customer-visible fallback configured; notifying human review instead`);
              await storePendingReplyAndNotify({
                config,
                core,
                route,
                accountId,
                sessionId,
                websiteId: inbound.websiteId,
                visitorName: inbound.visitorName,
                messageText: normalizedMessageText,
                mediaUrl,
              });
              markCurrentMessageProcessed();
            } else {
              try {
                console.log(`[crisp] 🛟 Trace ${traceId} triggering ${fallbackLabel} reason=${noValidDeliverReason}`);
                const fallbackSent = await sendTextToCrisp({
                  content: fallbackText,
                  logPrefix: `Trace ${traceId} ${fallbackLabel}`,
                });
                sentReply = fallbackSent;
                if (fallbackSent) {
                  console.log(`[crisp] 🛟 Trace ${traceId} ${fallbackLabel} sent successfully`);
                } else {
                  console.log(`[crisp] 🛟 Trace ${traceId} ${fallbackLabel} produced no customer-visible text; notifying human review instead`);
                  await storePendingReplyAndNotify({
                    config,
                    core,
                    route,
                    accountId,
                    sessionId,
                    websiteId: inbound.websiteId,
                    visitorName: inbound.visitorName,
                    messageText: normalizedMessageText,
                    mediaUrl,
                  });
                  markCurrentMessageProcessed();
                }
              } catch (fallbackErr) {
                console.error(`[crisp] ❌ Trace ${traceId} ${fallbackLabel} failed:`, fallbackErr);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[crisp] ❌ Failed to handle message:`, err);
      console.error(`[crisp] 🔎 Trace ${traceId} outer catch (${dispatchTimedOut ? "dispatch-timeout" : "error"}) elapsedMs=${Date.now() - handlerStartedAt}`);
      if (dispatchTimedOut && !sentReply && hasRepliedRef.value) {
        sentReply = true;
        console.log(`[crisp] 🔎 Trace ${traceId} direct channel/tool reply detected after timeout; skipping timeout fallback`);
      }
      if (dispatchTimedOut && !sentReply) {
        const recentOperatorReply = getRecentOperatorReplySince(processingKey, handlerStartedAt - 1000);
        if (recentOperatorReply) {
          sentReply = true;
          console.log(`[crisp] 🔎 Trace ${traceId} observed operator reply webhook after timeout; skipping timeout fallback fingerprint=${recentOperatorReply.fingerprint ?? "-"} ageMs=${Date.now() - recentOperatorReply.at}`);
        }
      }
      if (dispatchTimedOut && !sentReply) {
        const fallbackText = resolveSafeFallbackMessage(config.autoReplyFailureMessage);
        const latestProcessedState = getProcessedMessageState(processingKey, inboundMessageKey);
        if (latestProcessedState) {
          console.log(`[crisp] 🔎 Trace ${traceId} timeout-fallback skipped: message already marked processed source=${latestProcessedState.source} processedAt=${new Date(latestProcessedState.processedAt).toISOString()} ageMs=${Date.now() - latestProcessedState.processedAt}`);
        } else {
          if (!fallbackText) {
            console.log(`[crisp] 🛟 Trace ${traceId} timeout-fallback has no customer-visible fallback configured; notifying human review instead`);
            await storePendingReplyAndNotify({
              config,
              core,
              route,
              accountId,
              sessionId,
              websiteId: inbound.websiteId,
              visitorName: inbound.visitorName,
              messageText: normalizedMessageText,
              mediaUrl,
            });
            markCurrentMessageProcessed();
          } else {
            try {
              console.log(`[crisp] 🛟 Trace ${traceId} triggering timeout-fallback reason=dispatch-timeout`);
              const fallbackSent = await sendTextToCrisp({
                content: fallbackText,
                logPrefix: `Trace ${traceId} timeout-fallback`,
              });
              sentReply = fallbackSent;
              if (fallbackSent) {
                console.log(`[crisp] 🛟 Trace ${traceId} timeout-fallback sent successfully`);
              } else {
                console.log(`[crisp] 🛟 Trace ${traceId} timeout-fallback produced no customer-visible text; notifying human review instead`);
                await storePendingReplyAndNotify({
                  config,
                  core,
                  route,
                  accountId,
                  sessionId,
                  websiteId: inbound.websiteId,
                  visitorName: inbound.visitorName,
                  messageText: normalizedMessageText,
                  mediaUrl,
                });
                markCurrentMessageProcessed();
              }
            } catch (fallbackErr) {
              console.error(`[crisp] ❌ Trace ${traceId} timeout-fallback failed:`, fallbackErr);
            }
          }
        }
      }
    } finally {
      releaseAutoReplySlot?.();
    }

    console.log(`[crisp] 🔎 Trace ${traceId} end inbound handling elapsedMs=${Date.now() - handlerStartedAt} sentReply=${sentReply} hasRepliedRef=${hasRepliedRef.value} nonEmptyDeliverCount=${nonEmptyDeliverCount} emptyDeliverCount=${emptyDeliverCount} dispatchErrored=${dispatchErrored} dispatchTimedOut=${dispatchTimedOut}`);
    console.log(`[crisp] 🔓 Session lock release: ${processingKey}`);
  });
}

async function handleInboundMessage(
  config: CrispConfig,
  clawdbotConfig: ClawdbotConfig,
  accountId: string,
  payload: CrispWebhookPayload
): Promise<void> {
  const { data } = payload;

  if (data.from !== "user") {
    console.log(`[crisp] Skipping message from: ${data.from}`);
    return;
  }

  if (data.type && data.type !== "text" && data.type !== "file") {
    console.log(`[crisp] Skipping unsupported message type: ${data.type}`);
    return;
  }

  const inbound: BufferedInboundMessage = {
    websiteId: data.website_id,
    sessionId: data.session_id,
    type: data.type ?? "text",
    content: extractCrispContentText(data.content),
    origin: data.origin ?? "chat",
    from: "user",
    timestampMs: normalizeCrispTimestampMs(data.timestamp),
    fingerprint: data.fingerprint,
    visitorName: data.user?.nickname || "Visitor",
  };

  await enqueueCrispInbound({
    config,
    clawdbotConfig,
    accountId,
    trigger: "webhook",
    inbound,
  });
}

const YINGGE_AGENT_ID = "yingge";
const YINGGE_SESSIONS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "/",
  ".openclaw",
  "agents",
  YINGGE_AGENT_ID,
  "sessions"
);

function buildBaseCrispSessionKey(websiteId: string, sessionId: string): string {
  return `agent:${YINGGE_AGENT_ID}:crisp:direct:session_${sessionId}:${websiteId}`;
}

async function loadYinggeSessionStore(): Promise<Record<string, { sessionId?: string; file?: string }>> {
  const storePath = path.join(YINGGE_SESSIONS_DIR, "sessions.json");
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    return JSON.parse(raw) as Record<string, { sessionId?: string; file?: string }>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

async function handleSessionResolvedCleanup(params: {
  config: CrispConfig;
  websiteId: string;
  sessionId: string;
}): Promise<void> {
  const { config, websiteId, sessionId } = params;

  if (!config.crispSessionCleanupOnResolved) {
    console.log(`[crisp] 🧹 cleanup disabled for ${sessionId}; skipping`);
    return;
  }

  if (!hasCrispRuntime()) {
    console.warn(`[crisp] 🧹 no runtime available for cleanup of ${sessionId}`);
    return;
  }

  const core = getCrispRuntime();
  const baseKey = buildBaseCrispSessionKey(websiteId, sessionId);

  // Resolve all possible session keys: base + rolling windows in the store
  const store = await loadYinggeSessionStore();
  const keysToDelete: string[] = [];
  for (const [key, entry] of Object.entries(store)) {
    if (entry.sessionId === sessionId && (key === baseKey || key.startsWith(`${baseKey}:`))) {
      keysToDelete.push(key);
    }
  }
  if (keysToDelete.length === 0) {
    console.log(`[crisp] 🧹 no yingge sessions found for resolved Crisp session ${sessionId}`);
    return;
  }

  const archiveDate = new Date().toISOString().slice(0, 10);
  const archiveDir = path.join(YINGGE_SESSIONS_DIR, "archived-crisp-resolved", archiveDate, sessionId);
  await fs.mkdir(archiveDir, { recursive: true });

  for (const key of keysToDelete) {
    const entry = store[key];
    if (entry?.file) {
      const filePath = path.join(YINGGE_SESSIONS_DIR, entry.file);
      try {
        await fs.copyFile(filePath, path.join(archiveDir, entry.file));
      } catch (copyErr) {
        if ((copyErr as NodeJS.ErrnoException).code !== "ENOENT") {
          throw copyErr;
        }
      }
      const dotParts = entry.file.split(".");
      for (const ext of ["trajectory-path.json", "codex-app-server.json"]) {
        const sidecarFile = `${dotParts[0]}.${ext}`;
        const sidecarPath = path.join(YINGGE_SESSIONS_DIR, sidecarFile);
        try {
          await fs.copyFile(sidecarPath, path.join(archiveDir, sidecarFile));
        } catch (copyErr) {
          if ((copyErr as NodeJS.ErrnoException).code !== "ENOENT") {
            throw copyErr;
          }
        }
      }
    }

    await (core as unknown as { subagent: { deleteSession: (params: { sessionKey: string; deleteTranscript?: boolean }) => Promise<void> } }).subagent.deleteSession({ sessionKey: key, deleteTranscript: true });
    // Also remove from local store so the session key is released immediately
    delete store[key];
    console.log(`[crisp] 🧹 deleted yingge session ${key} for resolved Crisp session ${sessionId}`);
  }

  console.log(`[crisp] 🧹 archived ${keysToDelete.length} yingge session(s) to ${archiveDir} for resolved Crisp session ${sessionId}`);
}

function findLatestUserMessage(messages: CrispMessage[]): CrispMessage | null {
  const ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const latest = ordered.at(-1) ?? null;
  if (!latest) {
    return null;
  }
  if (latest.from !== "user") {
    return null;
  }
  if (latest.type !== "text" && latest.type !== "file") {
    return null;
  }
  return latest;
}

export async function runCrispProactiveSweep(params: {
  config: CrispConfig;
  clawdbotConfig: ClawdbotConfig;
  accountId: string;
}): Promise<void> {
  const { config, clawdbotConfig, accountId } = params;

  if (!config.proactiveSweepEnabled) {
    return;
  }
  if (!config.autoReply && !config.approvalMode) {
    console.log(`[crisp] 🧹 Sweep skipped for ${accountId}: autoReply=false approvalMode=false`);
    return;
  }

  const client = createCrispClient({
    apiKeyId: config.apiKeyId,
    apiKeySecret: config.apiKeySecret,
  });
  const now = Date.now();
  const windowStartMs = now - config.proactiveSweepWindowMs;
  const states = config.proactiveSweepStates;
  const candidates = new Map<string, CrispConversationListItem>();

  // Clean up stale rescue cooldowns to prevent unbounded Map growth.
  for (const [key, ts] of proactiveSweepRescueCooldowns.entries()) {
    if (now - ts > config.proactiveSweepRescueCooldownMs) {
      proactiveSweepRescueCooldowns.delete(key);
    }
  }

  for (const state of states) {
    try {
      const conversations = await client.listConversations(config.websiteId, {
        state,
        limit: config.proactiveSweepConversationLimit,
        page: 1,
      });
      for (const conversation of conversations) {
        candidates.set(conversation.session_id, conversation);
      }
    } catch (err) {
      console.error(`[crisp] 🧹 Sweep failed to list ${state} conversations for ${accountId}:`, err);
    }
  }

  const recentCandidates = [...candidates.values()].filter((conversation) => {
    const updatedAtMs = normalizeCrispTimestampMs(conversation.updated_at ?? conversation.created_at);
    return updatedAtMs >= windowStartMs;
  });

  console.log(
    `[crisp] 🧹 Sweep start account=${accountId} website=${config.websiteId} states=${states.join(",")} scanned=${recentCandidates.length} windowMs=${config.proactiveSweepWindowMs}`
  );

  const rescuedSessions: string[] = [];
  const skipReasons = new Map<string, number>();
  const verboseSkips = process.env.CRISP_SWEEP_VERBOSE === "1";
  const addSkipReason = (reason: string, detail: string): void => {
    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
    if (verboseSkips) {
      console.log(`[crisp] 🧹 Sweep skip ${detail} reason=${reason}`);
    }
  };

  for (const conversation of recentCandidates) {
    const sessionKey = buildTrackedSessionKey(accountId, config.websiteId, conversation.session_id);
    try {
      const messages = await client.getMessages(config.websiteId, conversation.session_id, {
        limit: config.proactiveSweepMessageLimit,
      });
      const latestUserMessage = findLatestUserMessage(messages);

      if (!latestUserMessage) {
        addSkipReason("latest_not_user", `session=${conversation.session_id}`);
        continue;
      }

      const latestMessageTsMs = normalizeCrispTimestampMs(latestUserMessage.timestamp);
      if (latestMessageTsMs < windowStartMs) {
        addSkipReason("message_outside_window", `session=${conversation.session_id}`);
        continue;
      }

      const messageAgeMs = now - latestMessageTsMs;
      if (messageAgeMs < config.proactiveSweepRescueDelayMs) {
        addSkipReason("message_too_recent", `session=${conversation.session_id} ageMs=${messageAgeMs} delayMs=${config.proactiveSweepRescueDelayMs}`);
        continue;
      }

      const sessionLocked = isSessionProcessingLocked(sessionKey);
      if (sessionLocked) {
        addSkipReason("session_locked", `session=${conversation.session_id}`);
        continue;
      }

      const lastRescueMs = proactiveSweepRescueCooldowns.get(sessionKey) ?? 0;
      if (now - lastRescueMs < config.proactiveSweepRescueCooldownMs) {
        addSkipReason("rescue_cooldown", `session=${conversation.session_id} cooldownMs=${config.proactiveSweepRescueCooldownMs}`);
        continue;
      }

      const operatorTextReply = messages.some((message) =>
        message.from === "operator" &&
        message.type === "text" &&
        message.timestamp >= latestUserMessage.timestamp
      );
      if (operatorTextReply) {
        addSkipReason("operator_text_reply_exists", `session=${conversation.session_id}`);
        continue;
      }

      const inboundMessageKey = buildInboundMessageKey({
        fingerprint: latestUserMessage.fingerprint,
        timestampMs: latestMessageTsMs,
        type: latestUserMessage.type,
        content: latestUserMessage.content,
      });
      const processed = getProcessedMessageState(sessionKey, inboundMessageKey);
      if (processed) {
        addSkipReason(`already_processed_by_${processed.source}`, `session=${conversation.session_id}`);
        continue;
      }

      console.log(
        `[crisp] 🧹 Sweep rescue session=${conversation.session_id} updatedAt=${conversation.updated_at ?? "-"} latestFingerprint=${latestUserMessage.fingerprint ?? "-"}`
      );

      await processInboundMessage({
        config,
        clawdbotConfig,
        accountId,
        trigger: "sweeper",
        inbound: {
          websiteId: config.websiteId,
          sessionId: conversation.session_id,
          type: latestUserMessage.type === "file" ? "file" : "text",
          content: latestUserMessage.content,
          origin: latestUserMessage.origin,
          from: "user",
          timestampMs: latestMessageTsMs,
          fingerprint: latestUserMessage.fingerprint,
          visitorName: latestUserMessage.user?.nickname || conversation.meta?.nickname || "Visitor",
        },
      });
      proactiveSweepRescueCooldowns.set(sessionKey, now);
      rescuedSessions.push(conversation.session_id);
      if (rescuedSessions.length >= config.proactiveSweepMaxRescuesPerTick) {
        addSkipReason("max_rescues_reached", `limit=${config.proactiveSweepMaxRescuesPerTick}`);
        break;
      }
    } catch (err) {
      addSkipReason("session_error", `session=${conversation.session_id}`);
      console.error(`[crisp] 🧹 Sweep session error session=${conversation.session_id}:`, err);
    }
  }

  const skipSummary = [...skipReasons.entries()]
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
  console.log(
    `[crisp] 🧹 Sweep complete account=${accountId} rescued=${rescuedSessions.length}${rescuedSessions.length ? ` sessions=${rescuedSessions.join(",")}` : ""} skipped=${skipSummary || "none"}`
  );
}

export function startCrispProactiveSweep(params: {
  config: CrispConfig;
  clawdbotConfig: ClawdbotConfig;
  accountId: string;
}): () => void {
  const { config, clawdbotConfig, accountId } = params;

  if (!config.proactiveSweepEnabled) {
    console.log(`[crisp] 🧹 Sweep disabled for ${accountId}`);
    return () => {};
  }

  let stopped = false;
  let running = false;
  const runTick = async (): Promise<void> => {
    if (stopped || running) {
      if (running) {
        console.log(`[crisp] 🧹 Sweep tick skipped for ${accountId}: previous tick still running`);
      }
      return;
    }
    running = true;
    try {
      await runCrispProactiveSweep({ config, clawdbotConfig, accountId });
    } finally {
      running = false;
    }
  };

  console.log(
    `[crisp] 🧹 Sweep scheduler started account=${accountId} intervalMs=${config.proactiveSweepIntervalMs} windowMs=${config.proactiveSweepWindowMs} limit=${config.proactiveSweepConversationLimit}`
  );

  const timer = setInterval(() => {
    void runTick();
  }, config.proactiveSweepIntervalMs);
  timer.unref?.();

  // Run one delayed startup tick so missed Crisp webhooks begin draining without
  // waiting for the first full interval, while still giving Gateway startup time
  // to finish registering channels and HTTP routes.
  const startupTimer = setTimeout(() => {
    void runTick();
  }, 5000);
  startupTimer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(startupTimer);
    console.log(`[crisp] 🧹 Sweep scheduler stopped account=${accountId}`);
  };
}

/**
 * Main webhook handler - register with Clawdbot HTTP server
 */
export async function handleCrispWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: CrispConfig,
  clawdbotConfig: ClawdbotConfig,
  accountId: string
): Promise<boolean> {
  console.log(`[crisp] Webhook request: ${req.method} ${req.url}`);

  // Only handle POST requests
  if (req.method !== "POST") {
    return false;
  }

  // Check if this is our webhook path
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const webhookPath = resolveWebhookPath(config);
  
  if (!url.pathname.startsWith(webhookPath)) {
    return false;
  }

  // Validate webhook secret
  if (!validateWebhookSecret(url, config.webhookSecret)) {
    console.warn(`[crisp] Invalid webhook secret from ${req.socket.remoteAddress}`);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid secret" }));
    return true;
  }

  try {
    // Parse body
    const { parsed, raw } = await parseJsonBody(req);
    const body = parsed as CrispWebhookPayload;

    const rawPreview = raw.length > 1200 ? `${raw.slice(0, 1200)}…` : raw;
    console.log(
      `[crisp] 📥 Raw webhook audit: path=${url.pathname} event=${body?.event ?? "-"} type=${body?.data?.type ?? "-"} from=${body?.data?.from ?? "-"} origin=${body?.data?.origin ?? "-"} session=${body?.data?.session_id ?? "-"} website=${body?.data?.website_id ?? body?.website_id ?? "-"} fingerprint=${body?.data?.fingerprint ?? "-"} stamped=${body?.data?.stamped ?? "-"} raw=${JSON.stringify(rawPreview)}`
    );

    console.log(`[crisp] Received webhook: ${body.event}`);
    console.log(
      `[crisp] Webhook detail: event=${body.event} type=${body.data?.type ?? "-"} from=${body.data?.from ?? "-"} origin=${body.data?.origin ?? "-"} session=${body.data?.session_id ?? "-"} website=${body.data?.website_id ?? "-"} content=${JSON.stringify(body.data?.content ?? "")}`
    );

    // Route by event type
    switch (body.event) {
      case "message:send":
        if (body.data?.from === "user" && isIgnoredSession({ accountId, websiteId: body.data.website_id, sessionId: body.data.session_id })) {
          console.log(`[crisp] 🔄 Reopening ignored session ${body.data.session_id} after user message`);
          releaseIgnoredSession({ accountId, websiteId: body.data.website_id, sessionId: body.data.session_id });
        }
        await handleInboundMessage(config, clawdbotConfig, accountId, body);
        break;

      case "message:received":
        if (body.data?.from === "user") {
          if (isIgnoredSession({ accountId, websiteId: body.data.website_id, sessionId: body.data.session_id })) {
            console.log(`[crisp] 🔄 Reopening ignored session ${body.data.session_id} after user message`);
            releaseIgnoredSession({ accountId, websiteId: body.data.website_id, sessionId: body.data.session_id });
          }
          console.log(
            `[crisp] 👤 User received-event treated as inbound: session=${body.data.session_id} website=${body.data.website_id} fingerprint=${body.data.fingerprint ?? "-"} type=${body.data.type ?? "-"} origin=${body.data.origin ?? "-"} content=${JSON.stringify(body.data.content ?? "")}`
          );
          await handleInboundMessage(config, clawdbotConfig, accountId, body);
          break;
        }
        if (body.data?.from === "operator") {
          const isHumanOperator = isHumanOperatorWebhook(body.data);
          const operatorContent = extractCrispContentText(body.data.content);
          if (body.data.type === "text" && operatorContent.trim()) {
            recordRecentOperatorReply({
              accountId,
              websiteId: body.data.website_id,
              sessionId: body.data.session_id,
              content: operatorContent,
              fingerprint: body.data.fingerprint,
              timestampMs: normalizeCrispTimestampMs(body.data.timestamp),
            });
          }
          console.log(
            `[crisp] 🧾 Operator receipt: session=${body.data.session_id} website=${body.data.website_id} fingerprint=${body.data.fingerprint ?? "-"} type=${body.data.type ?? "-"} origin=${body.data.origin ?? "-"} humanOperator=${isHumanOperator} content=${JSON.stringify(body.data.content ?? "")}`
          );
          if (config.approvalMode && isGlobalAutoModeEnabled() && isHumanOperator) {
            markHumanPauseSession({
              accountId,
              websiteId: body.data.website_id,
              sessionId: body.data.session_id,
            });
          }
        }
        // Non-user received events are informational only
        break;

      case "session:set_state":
        console.log(`[crisp] Conversation ${body.data.session_id} state: ${body.data.state}`);
        if (body.data.state === "resolved") {
          void handleSessionResolvedCleanup({
            config,
            websiteId: body.data.website_id,
            sessionId: body.data.session_id,
          }).catch((err: unknown) => {
            console.error(`[crisp] ❌ Cleanup error for session ${body.data.session_id}:`, err);
          });
        }
        break;

      case "session:set_email":
        const session = activeSessions.get(
          buildTrackedSessionKey(accountId, body.data.website_id, body.data.session_id)
        );
        if (session && body.data.email) {
          session.visitorEmail = body.data.email;
        }
        break;

      default:
        console.log(`[crisp] Unhandled event: ${body.event}`);
    }

    // Always return 200 to Crisp
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;

  } catch (err) {
    console.error(`[crisp] Webhook error:`, err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
    return true;
  }
}
