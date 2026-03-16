import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { markIgnoredSession, releaseIgnoredSession } from "./ignored-sessions.js";
import { handleCrispWebhookRequest } from "./monitor.js";
import { setCrispRuntime } from "./runtime.js";
import {
  findPendingReplyByTelegramMessage,
  getAllPendingReplies,
  markPendingReplySessionManaged,
  removePendingReply,
  storePendingReply,
} from "./pending-replies.js";
import {
  disableGlobalAutoMode,
  enableGlobalAutoMode,
  isManagedSession,
  markManagedSession,
  releaseManagedSession,
} from "./managed-sessions.js";
import type { CrispConfig, CrispWebhookPayload } from "./types.js";

function createConfig(): CrispConfig {
  return {
    websiteId: "123e4567-e89b-12d3-a456-426614174000",
    apiKeyId: "key-id",
    apiKeySecret: "key-secret",
    webhookPath: "/crisp-webhook",
    webhookSecret: "1234567890abcdef",
    enabled: true,
    autoReply: false,
    autoReplyMessage: "unused",
    operatorName: "Assistant",
    notifyOnNew: false,
    historyLimit: 0,
    resolveOnReply: false,
    approvalMode: true,
  };
}

function createPayload(sessionId: string, content: string): CrispWebhookPayload {
  return {
    website_id: "123e4567-e89b-12d3-a456-426614174000",
    event: "message:send",
    timestamp: Date.now(),
    data: {
      website_id: "123e4567-e89b-12d3-a456-426614174000",
      session_id: sessionId,
      type: "text",
      content,
      from: "user",
      origin: "chat",
      timestamp: Math.floor(Date.now() / 1000),
      fingerprint: 1001,
      user: {
        nickname: "访客A",
        user_id: "user-1",
      },
    },
  };
}

function createRequest(payload: CrispWebhookPayload) {
  const req = new PassThrough() as PassThrough & {
    method: string;
    url: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string };
  };
  req.method = "POST";
  req.url = "/crisp-webhook?secret=1234567890abcdef";
  req.headers = { host: "localhost" };
  req.socket = { remoteAddress: "127.0.0.1" };
  req.end(JSON.stringify(payload));
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

describe("handleCrispWebhookRequest", () => {
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn();
  const resolveAgentRoute = vi.fn(() => ({
    sessionKey: "crisp:session",
    accountId: "site1",
    agentId: "agent-1",
  }));
  const enqueueSystemEvent = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 9001 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/message")) {
        return new Response(JSON.stringify({ error: false, data: { fingerprint: 2002 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    }));

    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "自动回复内容" });
    });
    resolveAgentRoute.mockClear();
    enqueueSystemEvent.mockClear();

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
          dispatchReplyWithBufferedBlockDispatcher,
          formatAgentEnvelope: () => "",
          resolveEnvelopeFormatOptions: () => ({}),
        },
        routing: {
          resolveAgentRoute,
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
        enqueueSystemEvent,
      },
    } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    disableGlobalAutoMode();
    for (const pending of getAllPendingReplies()) {
      removePendingReply(pending.id);
    }
    releaseManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-approval",
    });
    releaseManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-managed",
    });
    releaseManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-exit",
    });
    releaseManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-command",
    });
    releaseManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-disable",
    });
    releaseIgnoredSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-ignored",
    });
  });

  it("defaults new conversations to managed mode while global auto mode is enabled", async () => {
    const req = createRequest(createPayload("session-approval", "我想咨询套餐"));
    const res = createResponse();

    const handled = await handleCrispWebhookRequest(req as never, res as never, createConfig(), {}, "site1");

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(getAllPendingReplies()).toHaveLength(0);
  });

  it("suppresses Telegram approval forwarding for ignored sessions", async () => {
    markIgnoredSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-ignored",
    });
    const req = createRequest(createPayload("session-ignored", "这条消息不再推送"));
    const res = createResponse();

    const handled = await handleCrispWebhookRequest(req as never, res as never, createConfig(), {}, "site1");

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(getAllPendingReplies()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/sendMessage"),
      expect.anything()
    );
  });

  it("sends Chinese Telegram approval notifications with site name and topic routing", async () => {
    const req = createRequest(createPayload("session-telegram", "我想咨询套餐"));
    const res = createResponse();
    const config = {
      ...createConfig(),
      name: "主站客服",
      approvalChatId: "-1001234567890",
      approvalThreadId: 818,
      telegramBotToken: "123456:telegram-token",
    };

    const handled = await handleCrispWebhookRequest(req as never, res as never, config, {}, "site1");

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456:telegram-token/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      })
    );

    const telegramCall = vi.mocked(fetch).mock.calls.find(([input]) =>
      String(input).includes("/sendMessage")
    );
    expect(telegramCall).toBeTruthy();

    const telegramBody = JSON.parse(String(telegramCall?.[1]?.body ?? "{}"));
    expect(telegramBody.chat_id).toBe("-1001234567890");
    expect(telegramBody.message_thread_id).toBe(818);
    expect(telegramBody.text).toContain("新的 Crisp 消息");
    expect(telegramBody.text).toContain("主站客服");
    expect(telegramBody.reply_markup.inline_keyboard).toEqual([
      [
        { text: "❌ 忽略", callback_data: expect.stringMatching(/^crisp_ignore_/) },
        { text: "🫴 托管", callback_data: expect.stringMatching(/^crisp_takeover_/) },
      ],
    ]);

    const [pending] = getAllPendingReplies();
    expect(pending).toBeTruthy();
    expect(findPendingReplyByTelegramMessage({
      telegramMessageId: "9001",
      telegramChatId: "-1001234567890",
    })?.id).toBe(pending.id);
  });

  it("bypasses approval after takeover and uses auto reply", async () => {
    const pending = storePendingReply({
      crispSessionId: "session-managed",
      crispWebsiteId: "123e4567-e89b-12d3-a456-426614174000",
      visitorName: "访客A",
      visitorMessage: "上一条消息",
      proposedReply: "",
      accountId: "site1",
    });
    markPendingReplySessionManaged(pending.id);

    const req = createRequest(createPayload("session-managed", "继续问一下发货时间"));
    const res = createResponse();

    const handled = await handleCrispWebhookRequest(req as never, res as never, createConfig(), {}, "site1");

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(getAllPendingReplies()).toHaveLength(1);
  });

  it("enables managed mode via #托管 and sends command feedback", async () => {
    const req = createRequest(createPayload("session-command", "#托管"));
    const res = createResponse();

    const handled = await handleCrispWebhookRequest(req as never, res as never, createConfig(), {}, "site1");

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(getAllPendingReplies()).toHaveLength(0);
    expect(isManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-command",
    })).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/message"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("已开启托管模式"),
      })
    );
  });

  it("keeps managed mode on, still notifies Telegram, and continues AI auto-reply on human-handoff keywords", async () => {
    markManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-exit",
    });

    const req = createRequest(createPayload("session-exit", "帮我转人工 support"));
    const res = createResponse();

    const handled = await handleCrispWebhookRequest(req as never, res as never, createConfig(), {}, "site1");

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(getAllPendingReplies()).toHaveLength(1);
    expect(isManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-exit",
    })).toBe(true);
  });

  it("disables managed mode via #取消托管 and sends command feedback", async () => {
    markManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-disable",
    });

    const req = createRequest(createPayload("session-disable", "#取消托管"));
    const res = createResponse();

    const handled = await handleCrispWebhookRequest(req as never, res as never, createConfig(), {}, "site1");

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(getAllPendingReplies()).toHaveLength(0);
    expect(isManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-disable",
    })).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/message"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("已关闭托管模式"),
      })
    );
  });

  it("defaults new conversations to managed mode while global auto mode is enabled", async () => {
    enableGlobalAutoMode();
    const req = createRequest(createPayload("session-global-auto", "帮我看看订阅状态"));
    const res = createResponse();

    const handled = await handleCrispWebhookRequest(req as never, res as never, createConfig(), {}, "site1");

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(getAllPendingReplies()).toHaveLength(0);
    expect(isManagedSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-global-auto",
    })).toBe(true);
  });
});
