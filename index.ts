/**
 * Clawdbot Crisp Channel Plugin
 * 
 * Receive and respond to Crisp website chat conversations.
 * 
 * @see https://github.com/just-the-v/openclaw-crisp
 * @see https://crisp.chat
 */

import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { crispPlugin, createCrispHttpHandler } from "./src/channel.js";
import { setCrispRuntime } from "./src/runtime.js";
import { collectTelegramWebhookPaths, createTelegramCallbackHttpHandler } from "./src/telegram-callback.js";

function collectCrispWebhookPaths(cfg: Record<string, unknown>): string[] {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const crispConfig = channels?.crisp as Record<string, unknown> | undefined;
  if (!crispConfig) return ["/crisp-webhook"];

  const paths = new Set<string>();
  const topLevelPath = typeof crispConfig.webhookPath === "string" ? crispConfig.webhookPath : undefined;
  if (topLevelPath) paths.add(topLevelPath);

  const accounts = crispConfig.accounts as Record<string, unknown> | undefined;
  if (accounts) {
    for (const account of Object.values(accounts)) {
      const accountConfig = account as Record<string, unknown>;
      const path = typeof accountConfig.webhookPath === "string" ? accountConfig.webhookPath : undefined;
      if (path) paths.add(path);
    }
  }

  if (paths.size === 0) paths.add("/crisp-webhook");
  return [...paths];
}

// Re-export types for consumers
export * from "./src/types.js";
export { createCrispClient } from "./src/api-client.js";
export { 
  getPendingReply, 
  removePendingReply, 
  sendCrispReply,
} from "./src/monitor.js";
export { 
  findPendingReplyByTelegramMessage,
  getAllPendingReplies,
  markPendingReplySessionManaged,
} from "./src/pending-replies.js";
export {
  HUMAN_HANDOFF_KEYWORDS,
  MANAGED_SESSION_EXIT_KEYWORDS,
  MANAGED_MODE_DISABLE_COMMANDS,
  MANAGED_MODE_ENABLE_COMMANDS,
  isHumanHandoffMessage,
  isManagedSession,
  markManagedSession,
  releaseManagedSession,
  shouldExitManagedSession,
} from "./src/managed-sessions.js";
export {
  collectTelegramWebhookPaths,
  createTelegramCallbackHttpHandler,
} from "./src/telegram-callback.js";
export type { PendingReply } from "./src/pending-replies.js";

/**
 * Plugin definition for Clawdbot
 */
const plugin = {
  id: "openclaw-crisp",
  name: "Crisp",
  description: "Crisp website chat channel for Clawdbot",
  configSchema: emptyPluginConfigSchema(),

  /**
   * Register the plugin with Clawdbot
   */
  register(api: ClawdbotPluginApi) {
    // Set runtime for webhook handler
    setCrispRuntime(api.runtime);

    // Register the channel plugin
    api.registerChannel({ plugin: crispPlugin });

    // Register HTTP routes for webhooks (OpenClaw >= 2026.3.x)
    const httpHandler = createCrispHttpHandler(api.config);
    const webhookPaths = collectCrispWebhookPaths(api.config as Record<string, unknown>);
    for (const path of webhookPaths) {
      api.registerHttpRoute({
        path,
        handler: httpHandler,
        auth: "plugin",
        match: "prefix",
        replaceExisting: true,
      });
    }

    const telegramHandler = createTelegramCallbackHttpHandler(api.config as Record<string, unknown>);
    const telegramPaths = collectTelegramWebhookPaths(api.config as Record<string, unknown>);
    console.log(`[crisp] Registering Telegram webhook routes: ${telegramPaths.join(", ") || "(none)"}`);
    for (const path of telegramPaths) {
      api.registerHttpRoute({
        path,
        handler: telegramHandler,
        auth: "plugin",
        match: "prefix",
        replaceExisting: true,
      });
    }
  },
};

export default plugin;
