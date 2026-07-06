/**
 * Crisp Channel Plugin for OpenClaw
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { CrispConfigSchema, type CrispConfig, type ResolvedCrispAccount } from "./types.js";
import { createCrispClient } from "./api-client.js";

const SAFE_VISIBLE_FALLBACK_MESSAGE = "";
const INTERNAL_REASONING_FALLBACK = SAFE_VISIBLE_FALLBACK_MESSAGE;
const CRISP_TARGET_PREFIX = "crisp:";

function parseCrispTarget(raw: string): {
  accountId?: string;
  websiteId?: string;
  sessionId: string;
} | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.toLowerCase().startsWith(CRISP_TARGET_PREFIX)) {
    const legacyParts = trimmed.split(":");
    if (legacyParts.length >= 3) {
      const [accountId, websiteId, ...sessionParts] = legacyParts;
      const sessionId = sessionParts.join(":").trim();
      if (accountId.trim() && websiteId.trim() && /^session_[A-Za-z0-9_-]+$/.test(sessionId)) {
        return { accountId: accountId.trim(), websiteId: websiteId.trim(), sessionId };
      }
    }
    return { sessionId: trimmed };
  }

  const remainder = trimmed.slice(CRISP_TARGET_PREFIX.length);
  const parts = remainder.split(":");
  if (parts.length >= 3) {
    const [accountId, websiteId, ...sessionParts] = parts;
    const sessionId = sessionParts.join(":").trim();
    if (accountId.trim() && websiteId.trim() && sessionId) {
      return {
        accountId: accountId.trim(),
        websiteId: websiteId.trim(),
        sessionId,
      };
    }
  }

  const sessionId = remainder.trim();
  return sessionId ? { sessionId } : null;
}

function looksLikeCrispSessionId(value: string): boolean {
  const trimmed = value.trim();
  return /^crisp:/i.test(trimmed) || /^session_[A-Za-z0-9_-]+$/.test(trimmed) || /^[A-Za-z0-9_-]+:[0-9a-f-]{36}:session_[A-Za-z0-9_-]+$/i.test(trimmed);
}

function readActionString(params: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveCrispActionTarget(params: {
  rawTarget?: string;
  currentChannelId?: string;
}): string | undefined {
  const raw = params.rawTarget?.trim();
  const current = params.currentChannelId?.trim();
  if (raw && looksLikeCrispSessionId(raw)) {
    return raw;
  }
  if (raw && !looksLikeCrispSessionId(raw) && current && looksLikeCrispSessionId(current)) {
    console.warn(`[crisp] ⚠️ Rewriting invalid Crisp action target ${JSON.stringify(raw)} to current session target`);
    return current;
  }
  if (current && looksLikeCrispSessionId(current)) {
    return current;
  }
  return raw;
}

function sanitizeOutboundText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^Reasoning:\s*_?Native reasoning was produced; no summary text was returned\.?_?\s*$/i.test(trimmed)) {
    return INTERNAL_REASONING_FALLBACK;
  }
  if (/^Reasoning[:：]/i.test(trimmed) || /Native reasoning was produced/i.test(trimmed)) {
    return INTERNAL_REASONING_FALLBACK;
  }
  if (/^(The user|I need|I should|I will)\b/i.test(trimmed) && /\b(knowledge base|reasoning|final answer|customer-facing)\b/i.test(trimmed)) {
    return INTERNAL_REASONING_FALLBACK;
  }
  return trimmed;
}
import { handleCrispWebhookRequest, resolveWebhookPath, startCrispProactiveSweep } from "./monitor.js";
import { setCrispRuntime } from "./runtime.js";

// Default account ID for single-account setups
const DEFAULT_ACCOUNT_ID = "default";

/**
 * Channel metadata for OpenClaw
 */
const meta = {
  id: "crisp",
  label: "Crisp",
  selectionLabel: "Crisp (website chat)",
  detailLabel: "Crisp Chat",
  docsPath: "/channels/crisp",
  docsLabel: "crisp",
  blurb: "Website chat via Crisp webhooks + REST API.",
  aliases: ["crisp-chat"],
  order: 80,
};

/**
 * Resolve account configuration from OpenClaw config
 */
function resolveCrispAccount(params: {
  cfg: Record<string, unknown>;
  accountId?: string;
}): ResolvedCrispAccount {
  const { cfg, accountId = DEFAULT_ACCOUNT_ID } = params;
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const crispConfig = channels?.crisp as Record<string, unknown> | undefined;

  if (!crispConfig) {
    return {
      accountId,
      name: accountId,
      enabled: false,
      configured: false,
      config: {} as CrispConfig,
      baseUrl: "https://api.crisp.chat/v1",
    };
  }

  // Support multi-account via accounts.{accountId}
  const accounts = crispConfig.accounts as Record<string, unknown> | undefined;
  const accountConfig = accountId !== DEFAULT_ACCOUNT_ID && accounts?.[accountId]
    ? { ...crispConfig, ...accounts[accountId] }
    : crispConfig;

  const parsed = CrispConfigSchema.safeParse(accountConfig);
  const config = parsed.success ? parsed.data : ({} as CrispConfig);

  const configured = Boolean(
    config.websiteId &&
    config.apiKeyId &&
    config.apiKeySecret &&
    config.webhookSecret
  );

  return {
    accountId,
    name: (accountConfig.name as string) || accountId,
    enabled: (accountConfig.enabled as boolean) !== false,
    configured,
    config,
    baseUrl: "https://api.crisp.chat/v1",
  };
}

/**
 * List available account IDs
 */
function listCrispAccountIds(cfg: Record<string, unknown>): string[] {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const crispConfig = channels?.crisp as Record<string, unknown> | undefined;

  if (!crispConfig) return [];

  const accounts = crispConfig.accounts as Record<string, unknown> | undefined;
  if (accounts && Object.keys(accounts).length > 0) {
    return Object.keys(accounts);
  }

  // Single account setup
  if (crispConfig.websiteId) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return [];
}

/**
 * The Crisp channel plugin
 */
export const crispPlugin = {
  id: "crisp",
  meta,

  capabilities: {
    chatTypes: ["direct"] as const,
    media: true,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    effects: false,
    groupManagement: false,
  },

  threading: {
    buildToolContext: ({ context, hasRepliedRef }: { context: Record<string, unknown>; hasRepliedRef?: { value: boolean } }) => ({
      currentChannelId: (context.To as string)?.trim() || undefined,
      currentThreadTs: context.ReplyToId as string | undefined,
      hasRepliedRef,
    }),
  },

  messaging: {
    normalizeTarget: (target: string) => {
      const parsed = parseCrispTarget(target);
      return parsed?.sessionId;
    },
    targetResolver: {
      hint: "Use a Crisp session id (session_xxx) or crisp:<account>:<website>:<session>.",
      looksLikeId: (raw: string) => looksLikeCrispSessionId(raw),
    },
  },

  actions: {
    supportsAction: ({ action }: { action: string }) => action === "send",
    handleAction: async ({ action, params, cfg, accountId, toolContext }: {
      action: string;
      params: Record<string, unknown>;
      cfg: Record<string, unknown>;
      accountId?: string;
      toolContext?: { currentChannelId?: string; hasRepliedRef?: { value: boolean } };
    }) => {
      if (action !== "send") return null;
      const rawTarget = readActionString(params, "target", "to", "channelId", "chatId");
      const target = resolveCrispActionTarget({
        rawTarget,
        currentChannelId: toolContext?.currentChannelId,
      });
      const message = readActionString(params, "message", "text", "content", "caption");
      const mediaUrl = readActionString(params, "media", "mediaUrl", "filePath", "path");
      if (!target) {
        return { channel: "crisp", ok: false, error: "Crisp send requires a session target or current Crisp context" };
      }
      if (!message && !mediaUrl) {
        return { channel: "crisp", ok: false, error: "Crisp send requires message or media" };
      }
      let result: { channel: string; ok: boolean; messageId?: string; error?: string } | undefined;
      if (message) {
        result = await crispPlugin.outbound.sendText({ cfg, to: target, text: message, accountId });
      }
      if (mediaUrl) {
        result = await crispPlugin.outbound.sendMedia({ cfg, to: target, mediaUrl, accountId });
      }
      if (result?.ok && toolContext?.hasRepliedRef) {
        toolContext.hasRepliedRef.value = true;
      }
      return result ?? { channel: "crisp", ok: false, error: "Crisp send did not run" };
    },
  },

  reload: {
    configPrefixes: ["channels.crisp"],
  },

  config: {
    listAccountIds: (cfg: Record<string, unknown>) => listCrispAccountIds(cfg),
    
    resolveAccount: (cfg: Record<string, unknown>, accountId?: string) =>
      resolveCrispAccount({ cfg, accountId }),
    
    defaultAccountId: (cfg: Record<string, unknown>) => {
      const ids = listCrispAccountIds(cfg);
      return ids[0] ?? DEFAULT_ACCOUNT_ID;
    },

    isConfigured: (account: ResolvedCrispAccount) => account.configured,

    describeAccount: (account: ResolvedCrispAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
  },

  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4000,

    resolveTarget: ({ to }: { to?: string }) => {
      const parsed = to ? parseCrispTarget(to) : null;
      if (!parsed?.sessionId) {
        return {
          ok: false as const,
          error: new Error("Crisp requires --to <session_id>"),
        };
      }
      return { ok: true as const, to: parsed.sessionId };
    },

    sendText: async (ctx: {
      cfg: Record<string, unknown>;
      to: string;
      text: string;
      accountId?: string;
    }) => {
      const { cfg, to, text, accountId } = ctx;
      const safeText = sanitizeOutboundText(text);
      if (!safeText) {
        return { channel: "crisp", ok: true, messageId: "suppressed-empty" };
      }
      if (safeText !== text.trim()) {
        console.warn(`[crisp] ⚠️ Sanitized unsafe outbound text before direct channel send (originalChars=${text.length}, sanitizedChars=${safeText.length})`);
      }
      const target = parseCrispTarget(to);
      const resolvedAccountId = target?.accountId ?? accountId;
      const account = resolveCrispAccount({ cfg, accountId: resolvedAccountId });

      if (!account.configured) {
        return { channel: "crisp", ok: false, error: "Crisp not configured" };
      }

      const client = createCrispClient({
        apiKeyId: account.config.apiKeyId,
        apiKeySecret: account.config.apiKeySecret,
      });

      try {
        const result = await client.sendMessage({
          websiteId: target?.websiteId ?? account.config.websiteId,
          sessionId: target?.sessionId ?? to,
          content: safeText,
        });

        return {
          channel: "crisp",
          ok: true,
          messageId: String(result.fingerprint),
        };
      } catch (err) {
        return {
          channel: "crisp",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    sendMedia: async (ctx: {
      cfg: Record<string, unknown>;
      to: string;
      mediaUrl: string;
      accountId?: string;
    }) => {
      const { cfg, to, mediaUrl, accountId } = ctx;
      const target = parseCrispTarget(to);
      const resolvedAccountId = target?.accountId ?? accountId;
      const account = resolveCrispAccount({ cfg, accountId: resolvedAccountId });

      if (!account.configured) {
        return { channel: "crisp", ok: false, error: "Crisp not configured" };
      }

      const client = createCrispClient({
        apiKeyId: account.config.apiKeyId,
        apiKeySecret: account.config.apiKeySecret,
      });

      try {
        const result = await client.sendMessage({
          websiteId: target?.websiteId ?? account.config.websiteId,
          sessionId: target?.sessionId ?? to,
          content: mediaUrl,
          type: "file",
        });

        return {
          channel: "crisp",
          ok: true,
          messageId: String(result.fingerprint),
        };
      } catch (err) {
        return {
          channel: "crisp",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      mode: "webhook",
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    probeAccount: async (params: { account: ResolvedCrispAccount }) => {
      const { account } = params;
      if (!account.configured) {
        return { ok: false as const, error: "Crisp not configured" };
      }

      const client = createCrispClient({
        apiKeyId: account.config.apiKeyId,
        apiKeySecret: account.config.apiKeySecret,
      });

      return client.probeWebsite(account.config.websiteId);
    },

    buildAccountSnapshot: (params: {
      account: ResolvedCrispAccount;
      runtime?: { running?: boolean; connected?: boolean; lastStartAt?: number | null };
    }) => {
      const { account, runtime } = params;
      const passiveReady = account.enabled && account.configured;
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        baseUrl: account.baseUrl,
        mode: "webhook",
        running: runtime?.running ?? passiveReady,
        connected: runtime?.connected ?? passiveReady,
        lastStartAt: runtime?.lastStartAt ?? null,
      };
    },
  },

  gateway: {
    startAccount: async (ctx: {
      account: ResolvedCrispAccount;
      accountId: string;
      cfg: Record<string, unknown>;
      runtime: { log?: { info?: (m: string) => void } };
      setStatus: (patch: Record<string, unknown>) => void;
      abortSignal: AbortSignal;
    }) => {
      const { account, runtime, setStatus, abortSignal, cfg } = ctx;
      const webhookPath = resolveWebhookPath(account.config);
      const stopSweep = startCrispProactiveSweep({
        config: account.config,
        clawdbotConfig: cfg as import("clawdbot/plugin-sdk").ClawdbotConfig,
        accountId: account.accountId,
      });

      runtime.log?.info?.(`[crisp:${account.accountId}] Starting (webhook=${webhookPath})`);

      setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
        mode: "webhook",
        running: true,
        connected: true,
        lastStartAt: Date.now(),
      });

      // Webhook channels are passive: keep the channel task alive until OpenClaw aborts it.
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          stopSweep();
          runtime.log?.info?.(`[crisp:${account.accountId}] Stopping`);
          setStatus({
            accountId: account.accountId,
            running: false,
            connected: false,
            lastStopAt: Date.now(),
          });
          resolve();
        };

        if (abortSignal.aborted) {
          onAbort();
          return;
        }

        abortSignal.addEventListener("abort", onAbort, { once: true });
      });
    },
  },
};

// Store config for HTTP handler access
let storedClawdbotConfig: Record<string, unknown> | null = null;

export function setClawdbotConfig(cfg: Record<string, unknown>): void {
  storedClawdbotConfig = cfg;
}

export function getClawdbotConfig(): Record<string, unknown> {
  if (!storedClawdbotConfig) {
    throw new Error("Clawdbot config not initialized");
  }
  return storedClawdbotConfig;
}

/**
 * Create HTTP handler for Crisp webhooks
 */
export function createCrispHttpHandler(cfg: Record<string, unknown>) {
  // Store config for later use
  setClawdbotConfig(cfg);
  
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    // Find which account this webhook is for
    const accountIds = listCrispAccountIds(cfg);
    
    for (const accountId of accountIds) {
      const account = resolveCrispAccount({ cfg, accountId });
      if (!account.configured || !account.enabled) continue;

      const webhookPath = resolveWebhookPath(account.config);
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      
      if (url.pathname.startsWith(webhookPath)) {
        // Pass both Crisp config and Clawdbot config
        const clawdbotCfg = storedClawdbotConfig ?? cfg;
        return handleCrispWebhookRequest(
          req, 
          res, 
          account.config, 
          clawdbotCfg as import("clawdbot/plugin-sdk").ClawdbotConfig,
          accountId
        );
      }
    }

    return false;
  };
}

export { setCrispRuntime };
