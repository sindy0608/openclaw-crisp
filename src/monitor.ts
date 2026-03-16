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
  isSolvedMessage,
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
async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(body));
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
async function handleInboundMessage(
  config: CrispConfig,
  clawdbotConfig: ClawdbotConfig,
  accountId: string,
  payload: CrispWebhookPayload
): Promise<void> {
  const { data } = payload;

  // Skip non-user messages
  if (data.from !== "user") {
    console.log(`[crisp] Skipping message from: ${data.from}`);
    return;
  }

  // Skip unsupported message types
  if (data.type && data.type !== "text" && data.type !== "file") {
    console.log(`[crisp] Skipping unsupported message type: ${data.type}`);
    return;
  }

  const sessionId = data.session_id;
  const visitorName = data.user?.nickname || "Visitor";
  const isFile = data.type === "file";
  const messageText = isFile ? "图片" : (data.content || "");
  const mediaUrl = isFile ? (data.content || "") : undefined;
  const managedSessionKey = {
    accountId,
    websiteId: data.website_id,
    sessionId,
  };

  console.log(`[crisp] 📩 Message from ${visitorName}: "${messageText}"`);
  console.log(`[crisp] Session: ${sessionId}, Website: ${data.website_id}`);

  // Track session for deduplication
  const session = trackSession(
    sessionId,
    data.website_id,
    accountId,
    visitorName,
    undefined
  );

  if (session.isNew) {
    console.log(`[crisp] 🆕 New conversation started`);
    if (isGlobalAutoModeEnabled()) {
      markManagedSession(managedSessionKey);
      console.log(`[crisp] 🤖 Global auto mode: defaulting new conversation ${sessionId} to managed mode`);
    }
  }

  // Skip if auto-reply is disabled and not in approval mode
  if (!config.autoReply && !config.approvalMode) {
    console.log(`[crisp] Auto-reply disabled, message logged only`);
    return;
  }

  // Check runtime
  if (!hasCrispRuntime()) {
    console.error(`[crisp] ❌ Runtime not available`);
    return;
  }

  const core = getCrispRuntime();
  const client = createCrispClient({
    apiKeyId: config.apiKeyId,
    apiKeySecret: config.apiKeySecret,
  });

  const sendManagedModeFeedback = async (content: string): Promise<void> => {
    await client.sendMessage({
      websiteId: data.website_id,
      sessionId,
      content,
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

  if (!isFile && isSolvedMessage(messageText)) {
    const closingMessage = "好的，感谢您的反馈～如果后续还有问题，随时联系我。祝您生活愉快！";
    try {
      await client.sendMessage({
        websiteId: data.website_id,
        sessionId,
        content: closingMessage,
      });
      console.log(`[crisp] 🙏 Sent closing message before resolve for ${sessionId}`);
      await client.updateConversationState(data.website_id, sessionId, "resolved");
      console.log(`[crisp] ✅ Marked conversation resolved from visitor confirmation: ${sessionId}`);
      releaseManagedSession(managedSessionKey);
      console.log(`[crisp] 🔓 Closed managed session without ignoring future follow-ups: ${sessionId}`);
    } catch (err) {
      console.error(`[crisp] ❌ Failed to close resolved session ${sessionId}:`, err);
    }
    return;
  }

  const normalizedMessageText = mediaUrl ? "图片" : messageText;

  const isSessionManaged = isManagedSession(managedSessionKey);
  const needsHumanHandoff = isHumanHandoffMessage(normalizedMessageText);

  // Fetch conversation history for AI context
  let historyText = "";
  if (config.historyLimit > 0) {
    try {
      const messages = await client.getMessages(
        data.website_id,
        sessionId,
        { limit: config.historyLimit }
      );
      const history = messages
        .reverse()
        .slice(0, -1)
        .map((msg) => `${msg.from === "user" ? visitorName : config.operatorName}: ${msg.content}`)
        .join("\n");
      if (history) {
        historyText = `\n\n[Previous messages]\n${history}\n[End of history]`;
      }
    } catch (err) {
      console.warn(`[crisp] Failed to fetch history: ${err}`);
    }
  }

  // Build body as plain text only; image/file messages are downgraded to the literal text "图片"
  const supportContext = await buildSupportKnowledge({
    accountId,
    websiteId: data.website_id,
    siteName: config.name,
  });
  const body = `${normalizedMessageText}${historyText}\n\n${supportContext}`;

  // Resolve agent route
  const route = core.channel.routing.resolveAgentRoute({
    cfg: clawdbotConfig,
    channel: "crisp",
    accountId,
    peer: {
      kind: "dm",
      id: sessionId,
    },
  });

  // Build context payload
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
    ConversationLabel: visitorName,
    SenderName: visitorName,
    SenderId: sessionId,
    Provider: "crisp",
    Surface: "crisp",
    MessageSid: data.fingerprint?.toString(),
    Timestamp: data.timestamp ? data.timestamp * 1000 : Date.now(),
    OriginatingChannel: "crisp",
    OriginatingTo: `crisp:${sessionId}`,
    WasMentioned: true,
    CommandAuthorized: true,
  };

  // =========================================================================
  // APPROVAL MODE: Store message and send Telegram notification
  // =========================================================================
  if (config.approvalMode && !isSessionManaged) {
    console.log(`[crisp] 🔄 Approval mode: storing for human review...`);

    await storePendingReplyAndNotify({
      config,
      core,
      route,
      accountId,
      sessionId,
      websiteId: data.website_id,
      visitorName,
      messageText: normalizedMessageText,
      mediaUrl: undefined,
    });
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
        websiteId: data.website_id,
        visitorName,
        messageText: normalizedMessageText,
        mediaUrl: undefined,
      });
    }
    console.log(`[crisp] 🫴 Managed session: suppressing approval forwarding and using auto-reply`);
  }

  // =========================================================================
  // AUTO-REPLY MODE: Send AI response directly
  // =========================================================================
  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: clawdbotConfig,
      dispatcherOptions: {
        deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }) => {
          const text = payload.text?.trim();
          if (!text) return;

          await client.sendMessage({
            websiteId: data.website_id,
            sessionId,
            content: text,
          });
          console.log(`[crisp] ✅ Sent AI reply to ${sessionId}`);

          if (config.resolveOnReply) {
            console.log(`[crisp] ⚠️ resolveOnReply is enabled for ${sessionId}, but auto-managed replies will stay open to allow follow-up messages`);
          }
        },
        onError: (err: unknown) => {
          console.error(`[crisp] ❌ Reply dispatch error:`, err);
        },
      },
    });
  } catch (err) {
    console.error(`[crisp] ❌ Failed to handle message:`, err);
  }
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
    const body = await parseJsonBody(req) as CrispWebhookPayload;

    console.log(`[crisp] Received webhook: ${body.event}`);

    // Route by event type
    switch (body.event) {
      case "message:send":
        await handleInboundMessage(config, clawdbotConfig, accountId, body);
        break;

      case "message:received":
        // This is when our message was received by Crisp, ignore
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
