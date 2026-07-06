import type { IncomingMessage, ServerResponse } from "node:http";

import { createCrispClient } from "./api-client.js";
import { getClawdbotConfig } from "./channel.js";
import {
  appendUnifiedKnowledgeBaseNote,
  buildSupportKnowledge,
  resolveUnifiedKnowledgeBasePath,
} from "./kb.js";
import { getCrispRuntime } from "./runtime.js";
import { markIgnoredSession, releaseIgnoredSession } from "./ignored-sessions.js";
import {
  disableGlobalAutoMode,
  enableGlobalAutoMode,
  getGlobalAutoModeExpiresAt,
  isGlobalAutoModeEnabled,
  releaseManagedSession,
} from "./managed-sessions.js";
import {
  findPendingReplyByTelegramMessage,
  getPendingReply,
  markPendingReplySessionManaged,
  removePendingReply,
  type PendingReply,
} from "./pending-replies.js";

const TELEGRAM_WEBHOOK_PREFIX = "/crisp-telegram-webhook";
const IGNORE_KEYWORDS = new Set(["ignore", "/ignore", "忽略", "/忽略"]);
const PENDING_KEYWORDS = new Set(["pending", "/pending", "待处理", "/待处理"]);
const MANAGED_REPLY_PREFIX = "#托管";
const IGNORE_SESSION_COMMAND = "#忽略";
const DIRECT_SEND_PREFIX = "#直发";
const KB_APPEND_PREFIX = "#知识库";
const GLOBAL_AUTO_MODE_ENABLE_PREFIX = "#自动模式";
const GLOBAL_AUTO_MODE_DISABLE_PREFIX = "#取消自动模式";
const GLOBAL_AUTO_MODE_STATUS_PREFIX = "#状态";

interface TelegramCallbackQuery {
  id?: string;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramChat {
  id?: number | string;
}

interface TelegramReplyMessage {
  message_id?: number;
}

interface TelegramMessage {
  message_id?: number;
  text?: string;
  chat?: TelegramChat;
  reply_to_message?: TelegramReplyMessage;
  message_thread_id?: number;
}

interface TelegramUpdate {
  callback_query?: TelegramCallbackQuery;
  message?: TelegramMessage;
}

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function buildTelegramWebhookPath(botToken: string): string {
  return `${TELEGRAM_WEBHOOK_PREFIX}/${encodeURIComponent(botToken)}`;
}

export function collectTelegramWebhookPaths(cfg: Record<string, unknown>): string[] {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const crispConfig = channels?.crisp as Record<string, unknown> | undefined;
  if (!crispConfig) return [];

  const paths = new Set<string>();
  const topLevelToken = typeof crispConfig.telegramBotToken === "string" ? crispConfig.telegramBotToken.trim() : "";
  if (topLevelToken) {
    paths.add(buildTelegramWebhookPath(topLevelToken));
  }

  const accounts = crispConfig.accounts as Record<string, unknown> | undefined;
  if (accounts) {
    for (const account of Object.values(accounts)) {
      const accountConfig = account as Record<string, unknown>;
      const accountToken = typeof accountConfig.telegramBotToken === "string" ? accountConfig.telegramBotToken.trim() : "";
      if (accountToken) {
        paths.add(buildTelegramWebhookPath(accountToken));
      }
    }
  }

  return [...paths];
}

async function answerTelegramCallback(botToken: string, callbackQueryId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    }),
  });
}

async function sendTelegramMessage(params: {
  botToken: string;
  chatId: string;
  text: string;
  threadId?: number;
  replyToMessageId?: number;
}): Promise<void> {
  const url = `https://api.telegram.org/bot${params.botToken}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: params.chatId,
      text: params.text,
      ...(params.threadId !== undefined ? { message_thread_id: params.threadId } : {}),
      ...(params.replyToMessageId !== undefined ? { reply_to_message_id: params.replyToMessageId } : {}),
    }),
  });
}

async function editTelegramMessageReplyMarkup(params: {
  botToken: string;
  chatId: string;
  messageId: number;
  inlineKeyboard: Array<Array<{ text: string; callback_data: string }>>;
}): Promise<void> {
  const url = `https://api.telegram.org/bot${params.botToken}/editMessageReplyMarkup`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: params.chatId,
      message_id: params.messageId,
      reply_markup: { inline_keyboard: params.inlineKeyboard },
    }),
  });
}

function normalizeChatId(value: number | string | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function normalizeMessageId(value: number | undefined): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

function resolvePendingReplyFromCallback(params: {
  pendingId?: string;
  callbackMessage?: TelegramMessage;
  botToken: string;
}): PendingReply | null {
  const { pendingId, callbackMessage, botToken } = params;
  const directMatch = pendingId ? getPendingReply(pendingId) : null;
  if (directMatch) {
    return directMatch;
  }

  const telegramMessageId = normalizeMessageId(callbackMessage?.message_id);
  const telegramChatId = normalizeChatId(callbackMessage?.chat?.id);
  if (!telegramMessageId || !telegramChatId) {
    return null;
  }

  const telegramThreadId = callbackMessage?.message_thread_id !== undefined
    ? String(callbackMessage.message_thread_id)
    : undefined;

  return findPendingReplyByTelegramMessage({
    telegramMessageId,
    telegramChatId,
    telegramThreadId,
    telegramBotToken: botToken,
  });
}

function matchesPendingReplyTelegramBinding(params: {
  pending: PendingReply;
  botToken: string;
  chatId: string;
  threadId?: string | null;
}): boolean {
  const { pending, botToken, chatId, threadId } = params;
  if (pending.telegramChatId && pending.telegramChatId !== chatId) {
    return false;
  }
  if (pending.telegramBotToken && pending.telegramBotToken !== botToken) {
    return false;
  }
  if (pending.telegramThreadId && threadId && pending.telegramThreadId !== threadId) {
    return false;
  }
  return true;
}

async function sendApprovedReply(pending: PendingReply, text: string): Promise<void> {
  const client = createCrispClient({
    apiKeyId: pending.crispApiKeyId,
    apiKeySecret: pending.crispApiKeySecret,
  });

  await client.sendMessage({
    websiteId: pending.crispWebsiteId,
    sessionId: pending.crispSessionId,
    content: text,
  });

  if (pending.resolveOnReply) {
    console.log(`[crisp] ⚠️ resolveOnReply is enabled for ${pending.crispSessionId}, but manual/Telegram replies will stay open to allow follow-up messages`);
  }
}

async function polishReplyWithAi(params: {
  pending: PendingReply;
  draft: string;
}): Promise<string> {
  const { pending, draft } = params;
  const core = getCrispRuntime();
  const supportContext = await buildSupportKnowledge({
    accountId: pending.accountId,
    websiteId: pending.crispWebsiteId,
    siteName: pending.siteName,
  });

  let polished = "";
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: {
      Body: `请将下面这段客服意图润色成一条可以直接发送给客户的中文客服回复。\n\n[客服知识]\n${supportContext}\n\n[客户原消息]\n${pending.visitorMessage}\n\n[人工意图]\n${draft}`,
      BodyForAgent: `请将下面这段客服意图润色成一条可以直接发送给客户的中文客服回复。\n\n[客服知识]\n${supportContext}\n\n[客户原消息]\n${pending.visitorMessage}\n\n[人工意图]\n${draft}`,
      RawBody: draft,
      CommandBody: draft,
      BodyForCommands: draft,
      From: `telegram:${pending.telegramChatId ?? "approval"}`,
      To: `crisp:${pending.crispSessionId}`,
      SessionKey: `crisp-assist:${pending.accountId}:${pending.crispWebsiteId}:${pending.crispSessionId}`,
      AccountId: pending.accountId,
      ChatType: "direct",
      ConversationLabel: pending.visitorName,
      SenderName: "客服人工草稿",
      SenderId: pending.crispSessionId,
      Provider: "crisp",
      Surface: "crisp",
      WasMentioned: true,
      CommandAuthorized: true,
    },
    cfg: getClawdbotConfig(),
    dispatcherOptions: {
      deliver: async (payload: { text?: string }) => {
        if (payload.text?.trim()) {
          polished += payload.text.trim();
        }
      },
      onError: (err: unknown) => {
        throw err instanceof Error ? err : new Error(String(err));
      },
    },
  });

  return polished.trim() || draft.trim();
}

async function generateAutoReplyForPending(pending: PendingReply): Promise<string> {
  const core = getCrispRuntime();
  const supportContext = await buildSupportKnowledge({
    accountId: pending.accountId,
    websiteId: pending.crispWebsiteId,
    siteName: pending.siteName,
  });

  let reply = "";
  const body = `${pending.visitorMessage}\n\n${supportContext}`;

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: {
      Body: body,
      BodyForAgent: body,
      RawBody: pending.visitorMessage,
      CommandBody: pending.visitorMessage,
      BodyForCommands: pending.visitorMessage,
      MediaUrl: undefined,
      From: `crisp:${pending.crispSessionId}`,
      To: `crisp:${pending.crispSessionId}`,
      SessionKey: `crisp-auto:${pending.accountId}:${pending.crispWebsiteId}:${pending.crispSessionId}`,
      AccountId: pending.accountId,
      ChatType: "direct",
      ConversationLabel: pending.visitorName,
      SenderName: pending.visitorName,
      SenderId: pending.crispSessionId,
      Provider: "crisp",
      Surface: "crisp",
      WasMentioned: true,
      CommandAuthorized: true,
    },
    cfg: getClawdbotConfig(),
    dispatcherOptions: {
      deliver: async (payload: { text?: string }) => {
        if (payload.text?.trim()) {
          reply += payload.text.trim();
        }
      },
      onError: (err: unknown) => {
        throw err instanceof Error ? err : new Error(String(err));
      },
    },
  });

  return reply.trim();
}

async function updateApprovalMessageState(params: {
  botToken: string;
  message?: TelegramMessage;
  ignoreActive?: boolean;
  managedActive?: boolean;
  pendingId: string;
}): Promise<void> {
  const chatId = normalizeChatId(params.message?.chat?.id);
  const messageId = params.message?.message_id;
  if (!chatId || messageId === undefined) {
    return;
  }

  await editTelegramMessageReplyMarkup({
    botToken: params.botToken,
    chatId,
    messageId,
    inlineKeyboard: [[
      {
        text: params.ignoreActive ? "↩️ 取消忽略" : "❌ 忽略",
        callback_data: `${params.ignoreActive ? "crisp_unignore_" : "crisp_ignore_"}${params.pendingId}`,
      },
      {
        text: params.managedActive ? "↩️ 取消托管" : "🫴 托管",
        callback_data: `${params.managedActive ? "crisp_untakeover_" : "crisp_takeover_"}${params.pendingId}`,
      },
    ]],
  });
}

function formatAutoModeUntil(expiresAt: number): string {
  if (!Number.isFinite(expiresAt) || expiresAt >= Number.MAX_SAFE_INTEGER / 2) {
    return "手动关闭前持续有效";
  }
  return new Date(expiresAt).toLocaleString("zh-CN", {
    timeZone: "Asia/Tokyo",
    hour12: false,
  });
}

function buildCrispStatusText(): string {
  const cfg = getClawdbotConfig();
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const crisp = channels?.crisp as Record<string, unknown> | undefined;
  const accounts = crisp?.accounts as Record<string, unknown> | undefined;
  const autoEnabled = isGlobalAutoModeEnabled();
  const expiresAt = getGlobalAutoModeExpiresAt();

  const lines = [
    `自动模式：${autoEnabled ? "已开启" : "已关闭"}`,
    `自动模式有效期：${autoEnabled ? formatAutoModeUntil(expiresAt ?? Number.MAX_SAFE_INTEGER) : "未开启"}`,
  ];

  if (!accounts || Object.keys(accounts).length === 0) {
    lines.push("Crisp 账号：未配置");
    return lines.join("\n");
  }

  lines.push("Crisp 账号状态：");
  for (const [accountId, raw] of Object.entries(accounts)) {
    const account = raw as Record<string, unknown>;
    const enabled = account.enabled !== false ? "on" : "off";
    const websiteId = typeof account.websiteId === "string" ? account.websiteId : "-";
    const webhookPath = typeof account.webhookPath === "string" ? account.webhookPath : "/crisp-webhook";
    const approvalChatId = account.approvalChatId ?? "-";
    const approvalThreadId = account.approvalThreadId ?? account.approvalTopicId ?? "-";
    const hasToken = typeof account.telegramBotToken === "string" && account.telegramBotToken.trim() ? "yes" : "no";
    lines.push(`- ${accountId}: enabled=${enabled}, website=${websiteId}, webhook=${webhookPath}, approval=${approvalChatId}/${approvalThreadId}, telegramBot=${hasToken}`);
  }

  return lines.join("\n");
}

async function handleTelegramCallbackUpdate(params: {
  botToken: string;
  callbackQuery: TelegramCallbackQuery;
}): Promise<void> {
  const { botToken, callbackQuery } = params;
  const callbackData = callbackQuery.data?.trim();
  if (!callbackQuery.id || !callbackData) {
    return;
  }

  if (callbackData.startsWith("crisp_takeover_")) {
    const pendingId = callbackData.slice("crisp_takeover_".length).trim();
    const pending = resolvePendingReplyFromCallback({
      pendingId,
      callbackMessage: callbackQuery.message,
      botToken,
    });
    if (pending) {
      markPendingReplySessionManaged(pending.id);
    }
    if (pending) {
      const ignoreReleased = releaseIgnoredSession({
        accountId: pending.accountId,
        websiteId: pending.crispWebsiteId,
        sessionId: pending.crispSessionId,
      });
      console.log(`[crisp] 🫴 Takeover enabled for ${pending.crispSessionId}; cleared ignore=${ignoreReleased}`);
      await updateApprovalMessageState({
        botToken,
        message: callbackQuery.message,
        pendingId: pending.id,
        ignoreActive: false,
        managedActive: true,
      });
    }
    if (pending) {
      try {
        const autoReply = await generateAutoReplyForPending(pending);
        if (autoReply) {
          await sendApprovedReply(pending, autoReply);
          // NOTE: Don't remove pending reply here, as user may want to cancel takeover later
          // It will be auto-cleaned up after TTL (1 hour)
        }
      } catch (err) {
        console.error(`[crisp] ❌ Failed to send immediate takeover reply for ${pending.crispSessionId}:`, err);
      }
    }
    const feedback = pending
      ? `已开启托管模式，并已自动回复当前消息 [${pending.id}]`
      : "未找到待处理会话，可能已过期";
    await answerTelegramCallback(botToken, callbackQuery.id, feedback);
    return;
  }

  if (callbackData.startsWith("crisp_reply_")) {
    const pendingId = callbackData.slice("crisp_reply_".length).trim();
    const pending = resolvePendingReplyFromCallback({
      pendingId,
      callbackMessage: callbackQuery.message,
      botToken,
    });
    const feedback = pending
      ? `请直接回复这条 Telegram 消息发送回复 [${pending.id}]`
      : "未找到待处理消息，可能已过期";
    await answerTelegramCallback(botToken, callbackQuery.id, feedback);
    return;
  }

  if (callbackData.startsWith("crisp_ignore_")) {
    const pendingId = callbackData.slice("crisp_ignore_".length).trim();
    const pending = resolvePendingReplyFromCallback({
      pendingId,
      callbackMessage: callbackQuery.message,
      botToken,
    });
    if (pending) {
      markIgnoredSession({
        accountId: pending.accountId,
        websiteId: pending.crispWebsiteId,
        sessionId: pending.crispSessionId,
      });
      await updateApprovalMessageState({
        botToken,
        message: callbackQuery.message,
        pendingId: pending.id,
        ignoreActive: true,
        managedActive: false,
      });
      removePendingReply(pending.id);
    }
    const feedback = pending
      ? `已忽略 [${pending.id}]`
      : "未找到待处理消息，可能已过期";
    await answerTelegramCallback(botToken, callbackQuery.id, feedback);
    return;
  }

  if (callbackData.startsWith("crisp_unignore_")) {
    const pendingId = callbackData.slice("crisp_unignore_".length).trim();
    const pending = resolvePendingReplyFromCallback({
      pendingId,
      callbackMessage: callbackQuery.message,
      botToken,
    });
    if (pending) {
      releaseIgnoredSession({
        accountId: pending.accountId,
        websiteId: pending.crispWebsiteId,
        sessionId: pending.crispSessionId,
      });
      await updateApprovalMessageState({
        botToken,
        message: callbackQuery.message,
        pendingId: pending.id,
        ignoreActive: false,
        managedActive: false,
      });
    }
    const feedback = pending
      ? `已取消忽略 [${pending.id}]`
      : "未找到待处理消息，可能已过期";
    await answerTelegramCallback(botToken, callbackQuery.id, feedback);
    return;
  }

  if (callbackData.startsWith("crisp_untakeover_")) {
    const pendingId = callbackData.slice("crisp_untakeover_".length).trim();
    const pending = resolvePendingReplyFromCallback({
      pendingId,
      callbackMessage: callbackQuery.message,
      botToken,
    });
    if (pending) {
      const managedReleased = releaseManagedSession({
        accountId: pending.accountId,
        websiteId: pending.crispWebsiteId,
        sessionId: pending.crispSessionId,
      });
      const ignoreReleased = releaseIgnoredSession({
        accountId: pending.accountId,
        websiteId: pending.crispWebsiteId,
        sessionId: pending.crispSessionId,
      });
      console.log(`[crisp] ↩️ Takeover disabled for ${pending.crispSessionId}; released managed=${managedReleased}, cleared ignore=${ignoreReleased}`);
      await updateApprovalMessageState({
        botToken,
        message: callbackQuery.message,
        pendingId: pending.id,
        ignoreActive: false,
        managedActive: false,
      });
    }
    const feedback = pending
      ? `已取消托管 [${pending.id}]`
      : "未找到待处理消息，可能已过期";
    await answerTelegramCallback(botToken, callbackQuery.id, feedback);
    return;
  }
}

async function handleTelegramMessageUpdate(params: {
  botToken: string;
  message: TelegramMessage;
}): Promise<void> {
  const { botToken, message } = params;
  const text = message.text?.trim();
  const chatId = normalizeChatId(message.chat?.id);
  const replyToMessageId = normalizeMessageId(message.reply_to_message?.message_id);

  if (!text || !chatId) {
    return;
  }

  if (text.includes(GLOBAL_AUTO_MODE_STATUS_PREFIX)) {
    await sendTelegramMessage({
      botToken,
      chatId,
      text: buildCrispStatusText(),
      threadId: message.message_thread_id,
      replyToMessageId: message.message_id,
    });
    return;
  }

  if (text.includes(GLOBAL_AUTO_MODE_DISABLE_PREFIX)) {
    const wasEnabled = disableGlobalAutoMode();
    await sendTelegramMessage({
      botToken,
      chatId,
      text: wasEnabled
        ? "已取消全局自动模式，两个站点的新 Crisp 会话都将恢复进入审批队列。"
        : "当前未启用全局自动模式。",
      threadId: message.message_thread_id,
      replyToMessageId: message.message_id,
    });
    return;
  }

  if (text.includes(GLOBAL_AUTO_MODE_ENABLE_PREFIX)) {
    enableGlobalAutoMode();
    await sendTelegramMessage({
      botToken,
      chatId,
      text: "已开启全局自动模式。两个站点（CMY / Mielink）的新 Crisp 会话都将默认进入 AI 托管，直到你发送 #取消自动模式 才会停止。",
      threadId: message.message_thread_id,
      replyToMessageId: message.message_id,
    });
    return;
  }

  if (!replyToMessageId) {
    return;
  }

  const threadId = message.message_thread_id !== undefined ? String(message.message_thread_id) : undefined;
  const pending = findPendingReplyByTelegramMessage({
    telegramMessageId: replyToMessageId,
    telegramChatId: chatId,
    telegramThreadId: threadId,
    telegramBotToken: botToken,
  });
  if (!pending) {
    return;
  }

  if (!matchesPendingReplyTelegramBinding({ pending, botToken, chatId, threadId })) {
    await sendTelegramMessage({
      botToken,
      chatId,
      text: `待处理消息绑定不匹配，已拒绝发送 [${pending.id}]`,
      threadId: message.message_thread_id,
      replyToMessageId: message.message_id,
    });
    return;
  }

  if (text === IGNORE_SESSION_COMMAND) {
    markIgnoredSession({
      accountId: pending.accountId,
      websiteId: pending.crispWebsiteId,
      sessionId: pending.crispSessionId,
    });
    removePendingReply(pending.id);
    await sendTelegramMessage({
      botToken,
      chatId,
      text: `已忽略该会话后续消息 [${pending.id}]`,
      threadId: message.message_thread_id,
      replyToMessageId: message.message_id,
    });
    return;
  }


  if (text.startsWith(KB_APPEND_PREFIX)) {
    const guidance = text.slice(KB_APPEND_PREFIX.length).trim();
    if (!guidance) {
      await sendTelegramMessage({
        botToken,
        chatId,
        text: `请在 #知识库 后补充要写入知识库的指导内容 [${pending.id}]`,
        threadId: message.message_thread_id,
        replyToMessageId: message.message_id,
      });
      return;
    }

    try {
      const kbWrite = await appendUnifiedKnowledgeBaseNote({
        accountId: pending.accountId,
        websiteId: pending.crispWebsiteId,
        siteName: pending.siteName,
        sessionId: pending.crispSessionId,
        visitorName: pending.visitorName,
        visitorMessage: pending.visitorMessage,
        guidance,
      });
      const finalReply = await polishReplyWithAi({ pending, draft: guidance });
      await sendApprovedReply(pending, finalReply);
      removePendingReply(pending.id);
      await sendTelegramMessage({
        botToken,
        chatId,
        text: `已写入统一知识库并发送客户回复 [${pending.id}]\nKB: ${kbWrite.path}`,
        threadId: message.message_thread_id,
        replyToMessageId: message.message_id,
      });
    } catch (err) {
      await sendTelegramMessage({
        botToken,
        chatId,
        text: `知识库写入或发送失败 [${pending.id}]：${err instanceof Error ? err.message : String(err)}\nKB: ${resolveUnifiedKnowledgeBasePath()}`,
        threadId: message.message_thread_id,
        replyToMessageId: message.message_id,
      });
    }
    return;
  }

  if (text.startsWith(MANAGED_REPLY_PREFIX)) {
    markPendingReplySessionManaged(pending.id);
    releaseIgnoredSession({
      accountId: pending.accountId,
      websiteId: pending.crispWebsiteId,
      sessionId: pending.crispSessionId,
    });
    const replyText = text.slice(MANAGED_REPLY_PREFIX.length).trim();
    if (!replyText) {
      await sendTelegramMessage({
        botToken,
        chatId,
        text: `已开启托管模式 [${pending.id}]，后续客户新消息将由影阁自动回复`,
        threadId: message.message_thread_id,
        replyToMessageId: message.message_id,
      });
      return;
    }

    try {
      const polished = await polishReplyWithAi({ pending, draft: replyText });
      await sendApprovedReply(pending, polished);
      removePendingReply(pending.id);
      await sendTelegramMessage({
        botToken,
        chatId,
        text: `已开启托管、润色回复并切换到 autoReply [${pending.id}]`,
        threadId: message.message_thread_id,
        replyToMessageId: message.message_id,
      });
    } catch (err) {
      await sendTelegramMessage({
        botToken,
        chatId,
        text: `发送失败 [${pending.id}]：${err instanceof Error ? err.message : String(err)}`,
        threadId: message.message_thread_id,
        replyToMessageId: message.message_id,
      });
    }
    return;
  }

  if (IGNORE_KEYWORDS.has(text.toLowerCase()) || IGNORE_KEYWORDS.has(text)) {
    removePendingReply(pending.id);
    await sendTelegramMessage({
      botToken,
      chatId,
      text: `已忽略 [${pending.id}]`,
      threadId: message.message_thread_id,
      replyToMessageId: message.message_id,
    });
    return;
  }

  if (PENDING_KEYWORDS.has(text.toLowerCase()) || PENDING_KEYWORDS.has(text)) {
    await sendTelegramMessage({
      botToken,
      chatId,
      text: `已保留待处理 [${pending.id}]`,
      threadId: message.message_thread_id,
      replyToMessageId: message.message_id,
    });
    return;
  }

  try {
    const finalReply = text.startsWith(DIRECT_SEND_PREFIX)
      ? text.slice(DIRECT_SEND_PREFIX.length).trim()
      : await polishReplyWithAi({ pending, draft: text });
    await sendApprovedReply(pending, finalReply || text);
    removePendingReply(pending.id);
    await sendTelegramMessage({
      botToken,
      chatId,
      text: text.startsWith(DIRECT_SEND_PREFIX)
        ? `已直发回复 [${pending.id}]`
        : `已润色并发送回复 [${pending.id}]`,
      threadId: message.message_thread_id,
      replyToMessageId: message.message_id,
    });
  } catch (err) {
    await sendTelegramMessage({
      botToken,
      chatId,
      text: `发送失败 [${pending.id}]：${err instanceof Error ? err.message : String(err)}`,
      threadId: message.message_thread_id,
      replyToMessageId: message.message_id,
    });
  }
}

export function createTelegramCallbackHttpHandler(pluginConfig: Record<string, unknown>) {
  const pathToToken = new Map<string, string>();
  for (const path of collectTelegramWebhookPaths(pluginConfig)) {
    const encodedToken = path.slice((`${TELEGRAM_WEBHOOK_PREFIX}/`).length);
    pathToToken.set(path, decodeURIComponent(encodedToken));
  }

  console.log(`[crisp] Telegram webhook paths registered: ${[...pathToToken.keys()].join(", ") || "(none)"}`);

  return async function handleTelegramCallbackRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> {
    if (req.method !== "POST") {
      return false;
    }

    const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
    const botToken = pathToToken.get(url.pathname);
    if (!botToken) {
      return false;
    }

    console.log(`[crisp] Telegram webhook hit: ${req.method} ${url.pathname}`);

    try {
      const update = await parseJsonBody(req) as TelegramUpdate;
      console.log(`[crisp] Telegram update kind: ${update.callback_query ? "callback_query" : update.message ? "message" : "unknown"}`);
      if (update.callback_query) {
        try {
          await handleTelegramCallbackUpdate({
            botToken,
            callbackQuery: update.callback_query,
          });
        } catch (err) {
          console.error("[crisp] ❌ Failed to answer Telegram callback:", err);
        }
      }

      if (update.message) {
        try {
          await handleTelegramMessageUpdate({
            botToken,
            message: update.message,
          });
        } catch (err) {
          console.error("[crisp] ❌ Failed to handle Telegram reply:", err);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return true;
    } catch (err) {
      console.error("[crisp] Telegram callback webhook error:", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request" }));
      return true;
    }
  };
}
