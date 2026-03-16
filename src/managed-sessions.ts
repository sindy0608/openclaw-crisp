/**
 * Managed Session Store
 *
 * Tracks Crisp sessions running in AI hosted/managed mode.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

export const HUMAN_HANDOFF_KEYWORDS = [
  "人工",
  "人工服务",
  "人工客服",
  "转人工",
  "支付",
  "扣费",
  "争议",
  "退款",
  "封禁",
  "解封",
  "投诉",
  "差评",
  "骗子",
  "合规",
  "风险",
  "无法登录",
  "不能用",
  "连不上",
  "失效",
  "human",
  "agent",
  "support",
] as const;

export const MANAGED_MODE_ENABLE_COMMANDS = ["#托管"] as const;
export const MANAGED_MODE_DISABLE_COMMANDS = ["#取消托管", "#结束托管"] as const;
export const SOLVED_KEYWORDS = [
  "谢谢",
  "多谢",
  "谢啦",
  "好的谢谢",
  "好叻，谢谢",
  "谢谢没事了",
  "谢谢已解决",
  "已解决",
  "解决了",
  "没事了",
  "ok了",
  "ok 啦",
  "ok啦",
  "好了",
  "没问题",
  "可以了",
  "搞定了",
  "明白了",
  "收到",
  "thank you",
  "thanks",
  "resolved",
  "solved",
  "ok",
] as const;

interface ManagedSessionKey {
  accountId: string;
  websiteId: string;
  sessionId: string;
}

interface ManagedSession extends ManagedSessionKey {
  accountIds: string[];
  activatedAt: number;
  lastSeenAt: number;
}

const managedSessions = new Map<string, ManagedSession>();
const MANAGED_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const GLOBAL_AUTO_MODE_DURATION_MS = 8 * 60 * 60 * 1000;
const HUMAN_HANDOFF_REGEX = /\b(?:human|agent|support)\b/i;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Keep temp-repo state local so test runs do not touch ~/.openclaw.
const STATE_DIR = path.join(ROOT_DIR, "state");
const GLOBAL_AUTO_MODE_FILE = path.join(STATE_DIR, "global-auto-mode.json");

interface GlobalAutoModeState {
  enabled: boolean;
  expiresAt: number;
  enabledAt: number;
}

function ensureStateDir(): void {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
  } catch {
    // ignore
  }
}

function readGlobalAutoModeState(): GlobalAutoModeState | null {
  try {
    ensureStateDir();
    if (!fs.existsSync(GLOBAL_AUTO_MODE_FILE)) {
      return null;
    }
    const content = fs.readFileSync(GLOBAL_AUTO_MODE_FILE, "utf-8");
    return JSON.parse(content) as GlobalAutoModeState;
  } catch {
    return null;
  }
}

function writeGlobalAutoModeState(state: GlobalAutoModeState): void {
  try {
    ensureStateDir();
    fs.writeFileSync(GLOBAL_AUTO_MODE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // ignore - fallback to memory only
  }
}

function buildManagedSessionKey(params: ManagedSessionKey): string {
  return `${params.websiteId}:${params.sessionId}`;
}

function mergeAccountId(accountIds: string[], accountId: string): string[] {
  return accountIds.includes(accountId) ? accountIds : [...accountIds, accountId];
}

function cleanupManagedSessions(now: number): void {
  const cutoff = now - MANAGED_SESSION_TTL_MS;
  for (const [key, value] of managedSessions) {
    if (value.lastSeenAt < cutoff) {
      managedSessions.delete(key);
    }
  }
}

export function markManagedSession(params: ManagedSessionKey): void {
  const now = Date.now();
  const key = buildManagedSessionKey(params);
  const existing = managedSessions.get(key);
  managedSessions.set(key, {
    ...params,
    accountIds: mergeAccountId(existing?.accountIds ?? [], params.accountId),
    activatedAt: existing?.activatedAt ?? now,
    lastSeenAt: now,
  });
  cleanupManagedSessions(now);
}

export function isManagedSession(params: ManagedSessionKey): boolean {
  const now = Date.now();
  const key = buildManagedSessionKey(params);
  const session = managedSessions.get(key);
  if (!session) {
    return false;
  }
  if (now - session.lastSeenAt > MANAGED_SESSION_TTL_MS) {
    managedSessions.delete(key);
    return false;
  }
  session.accountIds = mergeAccountId(session.accountIds, params.accountId);
  session.accountId = params.accountId;
  session.lastSeenAt = now;
  return true;
}

export function releaseManagedSession(params: ManagedSessionKey): boolean {
  return managedSessions.delete(buildManagedSessionKey(params));
}

export function enableGlobalAutoMode(now = Date.now()): number {
  const expiresAt = Number.MAX_SAFE_INTEGER;
  const state: GlobalAutoModeState = {
    enabled: true,
    expiresAt,
    enabledAt: now,
  };
  writeGlobalAutoModeState(state);
  console.log(`[crisp] Global auto mode enabled until manually disabled`);
  return expiresAt;
}

export function disableGlobalAutoMode(): boolean {
  const wasEnabled = isGlobalAutoModeEnabled();
  const state: GlobalAutoModeState = {
    enabled: false,
    expiresAt: 0,
    enabledAt: Date.now(),
  };
  writeGlobalAutoModeState(state);
  console.log(`[crisp] Global auto mode disabled`);
  return wasEnabled;
}

export function isGlobalAutoModeEnabled(_now = Date.now()): boolean {
  const state = readGlobalAutoModeState();
  return Boolean(state?.enabled);
}

export function getGlobalAutoModeExpiresAt(_now = Date.now()): number | null {
  const state = readGlobalAutoModeState();
  if (!state || !state.enabled) {
    return null;
  }
  return state.expiresAt;
}

function normalizeMessageText(messageText: string): string {
  return messageText.trim().toLowerCase();
}

export function isManagedModeEnableCommand(messageText: string): boolean {
  const normalized = normalizeMessageText(messageText);
  return MANAGED_MODE_ENABLE_COMMANDS.some((command) => normalized === command.toLowerCase());
}

export function isManagedModeDisableCommand(messageText: string): boolean {
  const normalized = normalizeMessageText(messageText);
  return MANAGED_MODE_DISABLE_COMMANDS.some((command) => normalized === command.toLowerCase());
}

function normalizeLooseMessage(messageText: string): string {
  return messageText
    .trim()
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function messageMatchesKeywordList(messageText: string, keywords: readonly string[]): boolean {
  const normalized = normalizeLooseMessage(messageText);
  return keywords.some((keyword) => {
    const lowerKeyword = normalizeLooseMessage(keyword);
    return normalized.includes(lowerKeyword);
  });
}

export function isHumanHandoffMessage(messageText: string): boolean {
  if (!messageText) {
    return false;
  }

  if (messageMatchesKeywordList(messageText, HUMAN_HANDOFF_KEYWORDS)) {
    return true;
  }

  return HUMAN_HANDOFF_REGEX.test(messageText);
}

export function isSolvedMessage(messageText: string): boolean {
  if (!messageText) {
    return false;
  }
  return messageMatchesKeywordList(messageText, SOLVED_KEYWORDS);
}

// Backward-compatible export while the rest of the codebase moves to the new naming.
export const MANAGED_SESSION_EXIT_KEYWORDS = HUMAN_HANDOFF_KEYWORDS;
export const shouldExitManagedSession = isHumanHandoffMessage;
