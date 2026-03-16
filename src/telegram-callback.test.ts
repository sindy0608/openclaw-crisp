import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setClawdbotConfig } from "./channel.js";
import { isIgnoredSession, releaseIgnoredSession } from "./ignored-sessions.js";
import {
  disableGlobalAutoMode,
  isGlobalAutoModeEnabled,
  isManagedSession,
  releaseManagedSession,
} from "./managed-sessions.js";
import {
  findPendingReplyByTelegramMessage,
  getAllPendingReplies,
  getPendingReply,
  removePendingReply,
  storePendingReply,
  updatePendingReplyTelegram,
} from "./pending-replies.js";
import { setCrispRuntime } from "./runtime.js";
import { collectTelegramWebhookPaths, createTelegramCallbackHttpHandler } from "./telegram-callback.js";

function createRequest(url: string, body: unknown) {
  const req = new PassThrough() as PassThrough & {
    method: string;
    url: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string };
  };
  req.method = "POST";
  req.url = url;
  req.headers = { host: "localhost" };
  req.socket = { remoteAddress: "127.0.0.1" };
  req.end(JSON.stringify(body));
  return req;
}

function createResponse() {
  return {
    statusCode: 0,
    body: "",
    writeHead(code: number) {
      this.statusCode = code;
      return this;
    },
    end(chunk?: string) {
      this.body = chunk ?? "";
      return this;
    },
  };
}

describe("Telegram callback webhook", () => {
  let kbPath = "";
  const pluginConfig = {
    channels: {
      crisp: {
        accounts: {
          site1: {
            websiteId: "123e4567-e89b-12d3-a456-426614174000",
            apiKeyId: "key-id",
            apiKeySecret: "key-secret",
            webhookSecret: "1234567890abcdef",
            telegramBotToken: "123456:abcDEF",
            approvalChatId: "-1001234567890",
          },
        },
      },
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    setClawdbotConfig({});
    setCrispRuntime({
      version: "test",
      channel: {
        text: {
          chunkMarkdownText: () => [],
          resolveTextChunkLimit: () => 4096,
          hasControlCommand: () => false,
          resolveMarkdownTableMode: () => "off",
          convertMarkdownTables: (text: string) => text,
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async ({ ctx, dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: `润色:${String(ctx.RawBody ?? "").trim()}` });
          }),
          formatAgentEnvelope: () => "",
          resolveEnvelopeFormatOptions: () => ({}),
        },
        routing: {
          resolveAgentRoute: () => ({ sessionKey: "crisp:test", accountId: "site1", agentId: "agent-1" }),
        },
        pairing: {
          buildPairingReply: () => "",
          readAllowFromStore: async () => [],
          upsertPairingRequest: async () => ({ code: "0000", created: true }),
        },
        media: {
          fetchRemoteMedia: async () => ({ buffer: Buffer.alloc(0), contentType: "text/plain" }),
          saveMediaBuffer: async () => ({ path: "/tmp/file", contentType: "text/plain" }),
        },
        session: {
          resolveStorePath: () => "/tmp",
          readSessionUpdatedAt: () => null,
        },
        mentions: {
          buildMentionRegexes: () => [],
          matchesMentionPatterns: () => false,
        },
        groups: {
          resolveRequireMention: () => false,
        },
      },
      logging: {
        shouldLogVerbose: () => false,
      },
      system: {
        enqueueSystemEvent: vi.fn(),
      },
    } as never);
    kbPath = "";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/message")) {
        return new Response(JSON.stringify({ error: false, data: { fingerprint: 2002 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 8001 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CRISP_UNIFIED_KB_PATH;
    for (const pending of getAllPendingReplies()) {
      removePendingReply(pending.id);
    }
    disableGlobalAutoMode();
    releaseManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-managed",
    });
    releaseIgnoredSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-ignored",
    });
  });

  it("marks the pending reply session as managed for takeover callbacks", async () => {
    const pending = storePendingReply({
      crispSessionId: "session-managed",
      crispWebsiteId: "123e4567-e89b-12d3-a456-426614174000",
      visitorName: "访客A",
      visitorMessage: "上一条消息",
      proposedReply: "",
      accountId: "site1",
    });

    const [path] = collectTelegramWebhookPaths(pluginConfig);
    const handler = createTelegramCallbackHttpHandler(pluginConfig);
    const req = createRequest(path, {
      callback_query: {
        id: "callback-1",
        data: `crisp_takeover_${pending.id}`,
        message: {
          message_id: 5005,
          chat: { id: "-1001234567890" },
          message_thread_id: 818,
        },
      },
    });
    const res = createResponse();

    const handled = await handler(req as never, res as never);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(isManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-managed",
    })).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456:abcDEF/answerCallbackQuery",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456:abcDEF/answerCallbackQuery",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("已开启托管模式，并已自动回复当前消息"),
      })
    );

    removePendingReply(pending.id);
  });

  it("keeps reply callbacks as instruction-only and preserves the pending item", async () => {
    const pending = storePendingReply({
      crispSessionId: "session-managed",
      crispWebsiteId: "123e4567-e89b-12d3-a456-426614174000",
      visitorName: "访客A",
      visitorMessage: "上一条消息",
      proposedReply: "",
      accountId: "site1",
    });

    const [path] = collectTelegramWebhookPaths(pluginConfig);
    const handler = createTelegramCallbackHttpHandler(pluginConfig);
    const req = createRequest(path, {
      callback_query: {
        id: "callback-reply",
        data: `crisp_reply_${pending.id}`,
      },
    });
    const res = createResponse();

    const handled = await handler(req as never, res as never);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456:abcDEF/answerCallbackQuery",
      expect.objectContaining({
        body: JSON.stringify({
          callback_query_id: "callback-reply",
          text: `请直接回复这条 Telegram 消息发送回复 [${pending.id}]`,
          show_alert: false,
        }),
      })
    );

    removePendingReply(pending.id);
  });

  it("removes pending replies for ignore callbacks", async () => {
    const pending = storePendingReply({
      crispSessionId: "session-managed",
      crispWebsiteId: "123e4567-e89b-12d3-a456-426614174000",
      visitorName: "访客A",
      visitorMessage: "上一条消息",
      proposedReply: "",
      accountId: "site1",
    });

    const [path] = collectTelegramWebhookPaths(pluginConfig);
    const handler = createTelegramCallbackHttpHandler(pluginConfig);
    const req = createRequest(path, {
      callback_query: {
        id: "callback-ignore",
        data: `crisp_ignore_${pending.id}`,
      },
    });
    const res = createResponse();

    const handled = await handler(req as never, res as never);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(getPendingReply(pending.id)).toBeNull();
  });

  it("matches Telegram replies by chat id and message id, then sends the approved reply to Crisp", async () => {
    const firstPending = storePendingReply({
      crispSessionId: "session-other-chat",
      crispWebsiteId: "123e4567-e89b-12d3-a456-426614174000",
      visitorName: "访客A",
      visitorMessage: "第一条消息",
      proposedReply: "",
      accountId: "site1",
    });
    updatePendingReplyTelegram(firstPending.id, "5001", "-100999");

    const secondPending = storePendingReply({
      crispSessionId: "session-managed",
      crispWebsiteId: "123e4567-e89b-12d3-a456-426614174000",
      visitorName: "访客B",
      visitorMessage: "第二条消息",
      proposedReply: "",
      accountId: "site1",
    });
    updatePendingReplyTelegram(secondPending.id, "5001", "-1001234567890");

    const [path] = collectTelegramWebhookPaths(pluginConfig);
    const handler = createTelegramCallbackHttpHandler(pluginConfig);
    const req = createRequest(path, {
      message: {
        message_id: 7001,
        text: "这是一条人工回复",
        chat: { id: "-1001234567890" },
        reply_to_message: { message_id: 5001 },
        message_thread_id: 818,
      },
    });
    const res = createResponse();

    const handled = await handler(req as never, res as never);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/website/123e4567-e89b-12d3-a456-426614174000/conversation/session-managed/message"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("润色:这是一条人工回复"),
      })
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456:abcDEF/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chat_id: "-1001234567890",
          text: `已润色并发送回复 [${secondPending.id}]`,
          message_thread_id: 818,
          reply_to_message_id: 7001,
        }),
      })
    );
  });

  it("enables managed mode and strips the prefix when operators reply with #托管", async () => {
    const pending = storePendingReply({
      crispSessionId: "session-managed",
      crispWebsiteId: "123e4567-e89b-12d3-a456-426614174000",
      visitorName: "访客B",
      visitorMessage: "第二条消息",
      proposedReply: "",
      accountId: "site1",
    });
    updatePendingReplyTelegram(pending.id, "5002", "-1001234567890");

    const [path] = collectTelegramWebhookPaths(pluginConfig);
    const handler = createTelegramCallbackHttpHandler(pluginConfig);
    const req = createRequest(path, {
      message: {
        message_id: 7003,
        text: "#托管 这条消息由人工发送",
        chat: { id: "-1001234567890" },
        reply_to_message: { message_id: 5002 },
        message_thread_id: 818,
      },
    });
    const res = createResponse();

    const handled = await handler(req as never, res as never);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(isManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-managed",
    })).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/website/123e4567-e89b-12d3-a456-426614174000/conversation/session-managed/message"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("润色:这条消息由人工发送"),
      })
    );
    expect(getPendingReply(pending.id)).toBeNull();
  });

  it("marks the session ignored for future Telegram forwarding on #忽略", async () => {
    const pending = storePendingReply({
      crispSessionId: "session-ignored",
      crispWebsiteId: "123e4567-e89b-12d3-a456-426614174000",
      visitorName: "访客C",
      visitorMessage: "第三条消息",
      proposedReply: "",
      accountId: "site1",
    });
    updatePendingReplyTelegram(pending.id, "5003", "-1001234567890");

    const [path] = collectTelegramWebhookPaths(pluginConfig);
    const handler = createTelegramCallbackHttpHandler(pluginConfig);
    const req = createRequest(path, {
      message: {
        message_id: 7004,
        text: "#忽略",
        chat: { id: "-1001234567890" },
        reply_to_message: { message_id: 5003 },
        message_thread_id: 818,
      },
    });
    const res = createResponse();

    const handled = await handler(req as never, res as never);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(isIgnoredSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-ignored",
    })).toBe(true);
    expect(getPendingReply(pending.id)).toBeNull();
  });

  it("keeps pending replies when operators answer with pending keywords", async () => {
    const pending = storePendingReply({
      crispSessionId: "session-managed",
      crispWebsiteId: "123e4567-e89b-12d3-a456-426614174000",
      visitorName: "访客A",
      visitorMessage: "上一条消息",
      proposedReply: "",
      accountId: "site1",
    });
    updatePendingReplyTelegram(pending.id, "6001", "-1001234567890");

    const [path] = collectTelegramWebhookPaths(pluginConfig);
    const handler = createTelegramCallbackHttpHandler(pluginConfig);
    const req = createRequest(path, {
      message: {
        message_id: 7002,
        text: "pending",
        chat: { id: "-1001234567890" },
        reply_to_message: { message_id: 6001 },
      },
    });
    const res = createResponse();

    const handled = await handler(req as never, res as never);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(findPendingReplyByTelegramMessage({
      telegramMessageId: "6001",
      telegramChatId: "-1001234567890",
    })?.id).toBe(pending.id);
    removePendingReply(pending.id);
  });

  it("appends #知识库 guidance to the unified KB and sends a polished customer reply", async () => {
    const pending = storePendingReply({
      crispSessionId: "session-kb",
      crispWebsiteId: "123e4567-e89b-12d3-a456-426614174000",
      visitorName: "访客D",
      visitorMessage: "支付失败怎么办",
      proposedReply: "",
      accountId: "site1",
      siteName: "主站客服",
    });
    updatePendingReplyTelegram(pending.id, "7005", "-1001234567890");

    const dir = await mkdtemp(join(tmpdir(), "crisp-kb-"));
    kbPath = join(dir, "crisp-kb-unified.md");
    process.env.CRISP_UNIFIED_KB_PATH = kbPath;
    await writeFile(kbPath, "# 初始知识库\n", "utf8");

    const [path] = collectTelegramWebhookPaths(pluginConfig);
    const handler = createTelegramCallbackHttpHandler(pluginConfig);
    const req = createRequest(path, {
      message: {
        message_id: 7006,
        text: "#知识库 支付失败时先建议客户更换支付渠道，并说明退款不支持。",
        chat: { id: "-1001234567890" },
        reply_to_message: { message_id: 7005 },
        message_thread_id: 818,
      },
    });
    const res = createResponse();

    const handled = await handler(req as never, res as never);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/website/123e4567-e89b-12d3-a456-426614174000/conversation/session-kb/message"),
      expect.objectContaining({
        body: expect.stringContaining("润色:支付失败时先建议客户更换支付渠道"),
      })
    );
    expect(await readFile(kbPath, "utf8")).toContain("支付失败时先建议客户更换支付渠道");
    expect(getPendingReply(pending.id)).toBeNull();
  });

  it("toggles global auto mode from Telegram approval replies", async () => {
    const pending = storePendingReply({
      crispSessionId: "session-auto",
      crispWebsiteId: "123e4567-e89b-12d3-a456-426614174000",
      visitorName: "访客E",
      visitorMessage: "帮我看看",
      proposedReply: "",
      accountId: "site1",
    });
    updatePendingReplyTelegram(pending.id, "8005", "-1001234567890");

    const [path] = collectTelegramWebhookPaths(pluginConfig);
    const handler = createTelegramCallbackHttpHandler(pluginConfig);
    const enableReq = createRequest(path, {
      message: {
        message_id: 8006,
        text: "#自动模式",
        chat: { id: "-1001234567890" },
        reply_to_message: { message_id: 8005 },
      },
    });
    const enableRes = createResponse();

    await handler(enableReq as never, enableRes as never);
    expect(isGlobalAutoModeEnabled()).toBe(true);

    const disableReq = createRequest(path, {
      message: {
        message_id: 8007,
        text: "#取消自动模式",
        chat: { id: "-1001234567890" },
        reply_to_message: { message_id: 8005 },
      },
    });
    const disableRes = createResponse();

    await handler(disableReq as never, disableRes as never);
    expect(isGlobalAutoModeEnabled()).toBe(false);
  });

  it("answers gracefully when the pending reply no longer exists", async () => {
    const [path] = collectTelegramWebhookPaths(pluginConfig);
    const handler = createTelegramCallbackHttpHandler(pluginConfig);
    const req = createRequest(path, {
      callback_query: {
        id: "callback-2",
        data: "crisp_takeover_MISSING",
      },
    });
    const res = createResponse();

    const handled = await handler(req as never, res as never);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456:abcDEF/answerCallbackQuery",
      expect.objectContaining({
        body: JSON.stringify({
          callback_query_id: "callback-2",
          text: "未找到待处理会话，可能已过期",
          show_alert: false,
        }),
      })
    );
  });
});
