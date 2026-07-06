import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { markIgnoredSession, releaseIgnoredSession } from "./ignored-sessions.js";
import { flushCrispInboundDebounceForTests, handleCrispWebhookRequest } from "./monitor.js";
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
  markHumanPauseSession,
  markManagedSession,
  releaseHumanPauseSession,
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
    autoReplySessionWindowMs: 0,
    historyMessageMaxChars: 1200,
    agentContextMaxChars: 60000,
    resolveOnReply: false,
    approvalMode: true,
    autoReplyTimeoutMs: 60000,
    autoReplyMaxConcurrent: 2,
    autoReplySlotWaitTimeoutMs: 5000,
    autoReplyFailureMessage: "抱歉，当前咨询较多，系统处理稍慢，请稍后再发一次。",
    autoReplyNoValidDeliverMessage: "您好，当前系统回复生成异常，请稍等，我帮您转人工处理。",
    autoReplyDispatchErrorMessage: "您好，当前系统回复生成异常，请稍等，我帮您转人工处理。",
    proactiveSweepEnabled: true,
    proactiveSweepIntervalMs: 60000,
    proactiveSweepWindowMs: 600000,
    proactiveSweepConversationLimit: 20,
    proactiveSweepMessageLimit: 10,
    proactiveSweepStates: ["pending", "unresolved"],
    proactiveSweepMaxRescuesPerTick: 3,
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
    releaseHumanPauseSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-human-pause",
    });
    releaseIgnoredSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-ignored",
    });
  });

  it("defaults new conversations to managed mode while global auto mode is enabled", async () => {
    enableGlobalAutoMode();
    const req = createRequest(createPayload("session-approval", "我想咨询套餐"));
    const res = createResponse();

    const handled = await handleCrispWebhookRequest(req as never, res as never, createConfig(), {}, "site1");
    await flushCrispInboundDebounceForTests();

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0].ctx).toMatchObject({
      To: "crisp:site1:123e4567-e89b-12d3-a456-426614174000:session-approval",
      OriginatingTo: "crisp:site1:123e4567-e89b-12d3-a456-426614174000:session-approval",
      AccountId: "site1",
      CrispAccountId: "site1",
      CrispWebsiteId: "123e4567-e89b-12d3-a456-426614174000",
      CrispSessionId: "session-approval",
      DeliveryTarget: "crisp:site1:123e4567-e89b-12d3-a456-426614174000:session-approval",
    });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(getAllPendingReplies()).toHaveLength(0);
  });

  it("uses a rolling lightweight agent session key when configured", async () => {
    enableGlobalAutoMode();
    const payload = createPayload("session-rolling", "我想咨询套餐");
    payload.data.timestamp = 1_700_000_000;
    const req = createRequest(payload);
    const res = createResponse();
    const config = {
      ...createConfig(),
      autoReplySessionWindowMs: 60_000,
    };

    const handled = await handleCrispWebhookRequest(req as never, res as never, config, {}, "site1");
    await flushCrispInboundDebounceForTests();

    expect(handled).toBe(true);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const expectedWindow = Math.floor(1_700_000_000_000 / 60_000);
    expect(dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0].ctx.SessionKey).toBe(`crisp:session:w${expectedWindow}`);
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
    await flushCrispInboundDebounceForTests();

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(resolveAgentRoute).not.toHaveBeenCalled();
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
    await flushCrispInboundDebounceForTests();

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
    await flushCrispInboundDebounceForTests();

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(getAllPendingReplies()).toHaveLength(1);
  });

  it("skips no-valid fallback when the agent replied via the Crisp message tool", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      replyOptions.hasRepliedRef.value = true;
    });

    const req = createRequest(createPayload("session-tool-replied", "有人吗"));
    const res = createResponse();
    const config = {
      ...createConfig(),
      autoReply: true,
      approvalMode: false,
      autoReplyTimeoutMs: 2000,
    };

    const handled = await handleCrispWebhookRequest(req as never, res as never, config, {}, "site1");
    await flushCrispInboundDebounceForTests();

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const crispCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/message'));
    expect(crispCalls).toHaveLength(0);
  });

  it("sends no-valid-deliver fallback when dispatcher completes without non-empty reply", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async () => {
      // complete successfully without any deliver callback
    });

    const req = createRequest(createPayload("session-empty-dispatch", "有人吗"));
    const res = createResponse();
    const config = {
      ...createConfig(),
      autoReply: true,
      approvalMode: false,
      autoReplyTimeoutMs: 2000,
      autoReplyNoValidDeliverMessage: "已收到你的消息，我这边先帮你看一下，请稍等。",
      autoReplyDispatchErrorMessage: "系统稍有延迟，请稍等。",
    };

    const handled = await handleCrispWebhookRequest(req as never, res as never, config, {}, "site1");
    await flushCrispInboundDebounceForTests();

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const crispCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes('/message'));
    expect(crispCall).toBeTruthy();
  });

  it("notifies human review instead of sending a built-in customer-visible fallback when no-valid config is empty", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async () => {
      // complete successfully without any deliver callback
    });

    const req = createRequest(createPayload("session-empty-config-fallback", "有人吗"));
    const res = createResponse();
    const config = {
      ...createConfig(),
      autoReply: true,
      approvalMode: false,
      autoReplyTimeoutMs: 2000,
      autoReplyNoValidDeliverMessage: "",
    };

    const handled = await handleCrispWebhookRequest(req as never, res as never, config, {}, "site1");
    await flushCrispInboundDebounceForTests();

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const crispCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes('/message'));
    expect(crispCall).toBeUndefined();
    expect(getAllPendingReplies()).toHaveLength(1);
    expect(enqueueSystemEvent).toHaveBeenCalled();
  });

  it("does not suppress normal customer replies that mention 判断 or 分析", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "目前判断更像是节点链路异常，不是您本地设置的问题。建议先切换到其他可用节点测试，我这边也会继续协助排查。" });
    });

    const req = createRequest(createPayload("session-normal-judgement", "其他节点也不正常"));
    const res = createResponse();
    const config = {
      ...createConfig(),
      autoReply: true,
      approvalMode: false,
      autoReplyTimeoutMs: 2000,
      autoReplyNoValidDeliverMessage: "不应发送fallback",
    };

    const handled = await handleCrispWebhookRequest(req as never, res as never, config, {}, "site1");
    await flushCrispInboundDebounceForTests();

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const messageCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/message'));
    expect(messageCalls).toHaveLength(1);
    expect(String(messageCalls[0]?.[1]?.body ?? '')).toContain('目前判断更像是节点链路异常');
    expect(getAllPendingReplies()).toHaveLength(0);
  });

  it("routes clear internal reasoning suppression to human review without a customer-visible fallback", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "分析：用户还在反馈不可用。\n回复策略：先检查节点和链路，不要直接下结论。" });
    });

    const req = createRequest(createPayload("session-internal-reasoning", "还是不行呢"));
    const res = createResponse();
    const config = {
      ...createConfig(),
      autoReply: true,
      approvalMode: false,
      autoReplyTimeoutMs: 2000,
      autoReplyNoValidDeliverMessage: "",
    };

    const handled = await handleCrispWebhookRequest(req as never, res as never, config, {}, "site1");
    await flushCrispInboundDebounceForTests();

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const messageCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/message'));
    expect(messageCalls).toHaveLength(0);
    expect(getAllPendingReplies()).toHaveLength(1);
    expect(enqueueSystemEvent).toHaveBeenCalled();
  });

  it("suppresses non-keyword customer follow-ups during human pause without Telegram or AI", async () => {
    markHumanPauseSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-human-pause",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const req = createRequest(createPayload("session-human-pause", "还是不行呢"));
    const res = createResponse();

    const handled = await handleCrispWebhookRequest(req as never, res as never, createConfig(), {}, "site1");
    await flushCrispInboundDebounceForTests();

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(resolveAgentRoute).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(getAllPendingReplies()).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("non-keyword follow-up suppressed during human pause")
    );
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("forwarding customer follow-up");
  });

  it("forwards human-handoff keyword messages during human pause without AI", async () => {
    markHumanPauseSession({
      accountId: "site1",
      websiteId: "123e4567-e89b-12d3-a456-426614174000",
      sessionId: "session-human-pause",
    });

    const req = createRequest(createPayload("session-human-pause", "帮我转人工"));
    const res = createResponse();

    const handled = await handleCrispWebhookRequest(req as never, res as never, createConfig(), {}, "site1");
    await flushCrispInboundDebounceForTests();

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(getAllPendingReplies()).toHaveLength(1);
  });

  it("does not send fallback if primary send already succeeded", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: '主回复已发出' });
    });

    const req = createRequest(createPayload("session-primary-ok", "测试一下"));
    const res = createResponse();
    const config = {
      ...createConfig(),
      autoReply: true,
      approvalMode: false,
      autoReplyTimeoutMs: 2000,
      autoReplyNoValidDeliverMessage: "不应再发fallback",
      autoReplyDispatchErrorMessage: "不应再发error fallback",
    };

    const handled = await handleCrispWebhookRequest(req as never, res as never, config, {}, "site1");
    await flushCrispInboundDebounceForTests();

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const messageCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/message'));
    expect(messageCalls).toHaveLength(1);
    expect(String(messageCalls[0]?.[1]?.body ?? '')).toContain('主回复已发出');
  });

  it("routes queue-timeout messages to human review instead of sending customer fallback spam", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    let releaseFirstDispatch!: () => void;
    const firstDispatchStarted = new Promise<void>((resolve) => {
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseFirstDispatch = release;
        });
      });
    });

    const config = {
      ...createConfig(),
      autoReply: true,
      approvalMode: false,
      autoReplyMaxConcurrent: 1,
      autoReplySlotWaitTimeoutMs: 25,
      autoReplyTimeoutMs: 60000,
      autoReplyFailureMessage: "抱歉，当前客服系统响应较慢，已通知人工客服，请稍等一下。",
    };

    const firstReq = createRequest(createPayload("session-busy-1", "第一条"));
    const firstRes = createResponse();
    const firstHandled = handleCrispWebhookRequest(firstReq as never, firstRes as never, config, {}, "site1");
    await flushCrispInboundDebounceForTests();
    await firstDispatchStarted;

    const secondReq = createRequest(createPayload("session-busy-2", "第二条"));
    const secondRes = createResponse();
    const secondHandled = await handleCrispWebhookRequest(secondReq as never, secondRes as never, config, {}, "site1");
    await flushCrispInboundDebounceForTests();

    expect(secondHandled).toBe(true);
    expect(secondRes.statusCode).toBe(200);
    const fallbackCall = vi.mocked(fetch).mock.calls.find(([input, init]) =>
      String(input).includes('/message') && String(init?.body ?? '').includes('当前客服系统响应较慢')
    );
    expect(fallbackCall).toBeUndefined();
    expect(getAllPendingReplies()).toHaveLength(1);
    expect(enqueueSystemEvent).toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

    releaseFirstDispatch();
    await firstHandled;
  });

  it("enables managed mode via #托管 and sends command feedback", async () => {
    const req = createRequest(createPayload("session-command", "#托管"));
    const res = createResponse();

    const handled = await handleCrispWebhookRequest(req as never, res as never, createConfig(), {}, "site1");
    await flushCrispInboundDebounceForTests();

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
    await flushCrispInboundDebounceForTests();

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
    await flushCrispInboundDebounceForTests();

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
    await flushCrispInboundDebounceForTests();

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
