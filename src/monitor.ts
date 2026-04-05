/**
 * Crisp Webhook Handler
 * 
 * Receives HTTP POST requests from Crisp and routes them to Clawdbot.
 * Supports human-in-the-loop approval mode.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import {
  DEFAULT_WEBHOOK_PATH,
  type CrispConfig,
  type CrispConversationListItem,
  type CrispMessage,
  type CrispSessionState,
  type CrispWebhookPayload,
} from "./types.js";
import { createCrispClient } from "./api-client.js";
import {
  isHumanHandoffMessage,
  isGlobalAutoModeEnabled,
  isManagedSession,
  isManagedModeDisableCommand,
  isManagedModeEnableCommand,
  markManagedSession,
  releaseManagedSession,
} from "./managed-sessions.js";
import { buildSupportKnowledge } from "./kb.js";
import { getCrispRuntime, hasCrispRuntime } from "./runtime.js";
import { storePendingReply, updatePendingReplyTelegram } from "./pending-replies.js";
import { sendTelegramNotification } from "./telegram-notify.js";

// In-memory session tracking for notification deduplication
const activeSessions = new Map<string, CrispSessionState>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Prevent same Crisp session from running multiple auto-replies concurrently.
const sessionProcessingLocks = new Map<string, Promise<void>>();
const sweepProcessedMessages = new Map<string, { messageKey: string; processedAt: number; source: "webhook" | "sweeper" }>();
const SWEEP_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

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
  const existing = activeSessions.get(sessionId);
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

  activeSessions.set(sessionId, session);

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

/**
 * Handle inbound message from Crisp
 */
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

async function enqueueCrispInbound(params: {
  config: CrispConfig;
  clawdbotConfig: ClawdbotConfig;
  accountId: string;
  trigger: "webhook" | "sweeper";
  inbound: BufferedInboundMessage;
}): Promise<void> {
  const shouldDebounce = params.trigger === "webhook" && params.inbound.type === "text" && Boolean(params.inbound.content.trim());
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
    }): Promise<void> => {
      const text = params.content.trim();
      if (!text) {
        console.warn(`[crisp] ⚠️ ${params.logPrefix} skipped empty text payload`);
        return;
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

    let historyText = "";
    if (config.historyLimit > 0) {
      try {
        console.log(`[crisp] 🔎 Trace ${traceId} fetching history (limit=${config.historyLimit})`);
        const messages = await client.getMessages(
          inbound.websiteId,
          sessionId,
          { limit: config.historyLimit }
        );
        const history = messages
          .reverse()
          .slice(0, -1)
          .map((msg) => `${msg.from === "user" ? inbound.visitorName : config.operatorName}: ${msg.content}`)
          .join("\n");
        if (history) {
          historyText = `\n\n[Previous messages]\n${history}\n[End of history]`;
        }
        console.log(`[crisp] 🔎 Trace ${traceId} history ready (messages=${messages.length}, chars=${historyText.length})`);
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
    const body = `${normalizedMessageText}${historyText}\n\n${supportContext}`;
    console.log(`[crisp] 🔎 Trace ${traceId} support knowledge ready (chars=${supportContext.length}, bodyChars=${body.length})`);

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

    const ctxPayload = {
      Body: body,
      BodyForAgent: body,
      RawBody: normalizedMessageText,
      CommandBody: normalizedMessageText,
      BodyForCommands: normalizedMessageText,
      MediaUrl: undefined,
      From: `crisp:${sessionId}`,
      To: `crisp:${sessionId}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: "direct",
      ConversationLabel: inbound.visitorName,
      SenderName: inbound.visitorName,
      SenderId: sessionId,
      Provider: "crisp",
      Surface: "crisp",
      MessageSid: inbound.fingerprint?.toString(),
      Timestamp: inbound.timestampMs,
      OriginatingChannel: "crisp",
      OriginatingTo: `crisp:${sessionId}`,
      WasMentioned: true,
      CommandAuthorized: true,
    };

    if (config.approvalMode && !isSessionManaged) {
      console.log(`[crisp] 🔄 Approval mode: storing for human review...`);

      await storePendingReplyAndNotify({
        config,
        core,
        route,
        accountId,
        sessionId,
        websiteId: inbound.websiteId,
        visitorName: inbound.visitorName,
        messageText: normalizedMessageText,
        mediaUrl: undefined,
      });
      markCurrentMessageProcessed();
      return;
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
          mediaUrl: undefined,
        });
      }
      console.log(`[crisp] 🫴 Managed session: suppressing approval forwarding and using auto-reply`);
    }

    let sentReply = false;
    let nonEmptyDeliverCount = 0;
    let emptyDeliverCount = 0;
    let dispatchErrored = false;
    let dispatchTimedOut = false;

    try {
      console.log(`[crisp] 🔎 Trace ${traceId} dispatch start (timeoutMs=${config.autoReplyTimeoutMs})`);

      const dispatchPromise = core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: clawdbotConfig,
        dispatcherOptions: {
          deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }) => {
            console.log(`[crisp] 🔎 Trace ${traceId} deliver invoked (hasText=${Boolean(payload.text?.trim())}, mediaUrls=${payload.mediaUrls?.length ?? 0}, mediaUrl=${payload.mediaUrl ? 1 : 0})`);
            const text = payload.text?.trim();
            if (!text) {
              emptyDeliverCount += 1;
              console.warn(`[crisp] ⚠️ Trace ${traceId} empty deliver payload (#${emptyDeliverCount})`);
              return;
            }

            nonEmptyDeliverCount += 1;
            await sendTextToCrisp({
              content: text,
              logPrefix: `Trace ${traceId} deliver#${nonEmptyDeliverCount}`,
            });
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
      console.log(`[crisp] 🔎 Trace ${traceId} dispatch complete (sentReply=${sentReply}, nonEmptyDeliverCount=${nonEmptyDeliverCount}, emptyDeliverCount=${emptyDeliverCount}, dispatchErrored=${dispatchErrored}, elapsedMs=${Date.now() - handlerStartedAt})`);

      if (!sentReply) {
        const noValidDeliverReason = dispatchErrored ? "dispatch-error-no-valid-deliver" : "dispatch-complete-no-valid-deliver";
        console.warn(`[crisp] ⚠️ Trace ${traceId} dispatch finished without valid deliver (${noValidDeliverReason})`);

        const fallbackText = dispatchErrored
          ? config.autoReplyDispatchErrorMessage.trim()
          : config.autoReplyNoValidDeliverMessage.trim();
        const fallbackLabel = dispatchErrored ? "dispatch-error-fallback" : "no-valid-deliver-fallback";
        const shouldFallback = dispatchErrored || nonEmptyDeliverCount === 0;
        const latestProcessedState = getProcessedMessageState(processingKey, inboundMessageKey);

        if (shouldFallback) {
          if (!fallbackText) {
            console.warn(`[crisp] ⚠️ Trace ${traceId} ${fallbackLabel} skipped: empty configured message`);
          } else if (latestProcessedState) {
            console.log(`[crisp] 🔎 Trace ${traceId} ${fallbackLabel} skipped: message already marked processed source=${latestProcessedState.source} processedAt=${new Date(latestProcessedState.processedAt).toISOString()} ageMs=${Date.now() - latestProcessedState.processedAt}`);
          } else {
            try {
              console.log(`[crisp] 🛟 Trace ${traceId} triggering ${fallbackLabel} reason=${noValidDeliverReason}`);
              await sendTextToCrisp({
                content: fallbackText,
                logPrefix: `Trace ${traceId} ${fallbackLabel}`,
              });
              sentReply = true;
              console.log(`[crisp] 🛟 Trace ${traceId} ${fallbackLabel} sent successfully`);
            } catch (fallbackErr) {
              console.error(`[crisp] ❌ Trace ${traceId} ${fallbackLabel} failed:`, fallbackErr);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[crisp] ❌ Failed to handle message:`, err);
      console.error(`[crisp] 🔎 Trace ${traceId} outer catch (${dispatchTimedOut ? "dispatch-timeout" : "error"}) elapsedMs=${Date.now() - handlerStartedAt}`);
    }

    console.log(`[crisp] 🔎 Trace ${traceId} end inbound handling elapsedMs=${Date.now() - handlerStartedAt} sentReply=${sentReply} nonEmptyDeliverCount=${nonEmptyDeliverCount} emptyDeliverCount=${emptyDeliverCount} dispatchErrored=${dispatchErrored} dispatchTimedOut=${dispatchTimedOut}`);
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
    content: data.content || "",
    origin: data.origin ?? "chat",
    from: "user",
    timestampMs: data.timestamp ? data.timestamp * 1000 : Date.now(),
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
  const states: Array<"pending" | "unresolved"> = ["pending", "unresolved"];
  const candidates = new Map<string, CrispConversationListItem>();

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
    const updatedAtMs = (conversation.updated_at ?? conversation.created_at ?? 0) * 1000;
    return updatedAtMs >= windowStartMs;
  });

  console.log(
    `[crisp] 🧹 Sweep start account=${accountId} website=${config.websiteId} states=${states.join(",")} scanned=${recentCandidates.length} windowMs=${config.proactiveSweepWindowMs}`
  );

  const rescuedSessions: string[] = [];
  const skipReasons = new Map<string, number>();
  const addSkipReason = (reason: string, detail: string): void => {
    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
    console.log(`[crisp] 🧹 Sweep skip ${detail} reason=${reason}`);
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

      const latestMessageTsMs = latestUserMessage.timestamp * 1000;
      if (latestMessageTsMs < windowStartMs) {
        addSkipReason("message_outside_window", `session=${conversation.session_id}`);
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
      rescuedSessions.push(conversation.session_id);
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

  return () => {
    stopped = true;
    clearInterval(timer);
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
        await handleInboundMessage(config, clawdbotConfig, accountId, body);
        break;

      case "message:received":
        if (body.data?.from === "user") {
          console.log(
            `[crisp] 👤 User received-event treated as inbound: session=${body.data.session_id} website=${body.data.website_id} fingerprint=${body.data.fingerprint ?? "-"} type=${body.data.type ?? "-"} origin=${body.data.origin ?? "-"} content=${JSON.stringify(body.data.content ?? "")}`
          );
          await handleInboundMessage(config, clawdbotConfig, accountId, body);
          break;
        }
        if (body.data?.from === "operator") {
          console.log(
            `[crisp] 🧾 Operator receipt: session=${body.data.session_id} website=${body.data.website_id} fingerprint=${body.data.fingerprint ?? "-"} type=${body.data.type ?? "-"} origin=${body.data.origin ?? "-"} content=${JSON.stringify(body.data.content ?? "")}`
          );
        }
        // Non-user received events are informational only
        break;

      case "session:set_state":
        console.log(`[crisp] Conversation ${body.data.session_id} state: ${body.data.state}`);
        break;

      case "session:set_email":
        const session = activeSessions.get(body.data.session_id);
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
