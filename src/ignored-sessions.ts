interface IgnoredSessionKey {
  accountId: string;
  websiteId: string;
  sessionId: string;
}

interface IgnoredSession extends IgnoredSessionKey {
  accountIds: string[];
  ignoredAt: number;
  lastSeenAt: number;
}

const ignoredSessions = new Map<string, IgnoredSession>();
const IGNORED_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function buildIgnoredSessionKey(params: IgnoredSessionKey): string {
  return `${params.websiteId}:${params.sessionId}`;
}

function mergeAccountId(accountIds: string[], accountId: string): string[] {
  return accountIds.includes(accountId) ? accountIds : [...accountIds, accountId];
}

function cleanupIgnoredSessions(now: number): void {
  const cutoff = now - IGNORED_SESSION_TTL_MS;
  for (const [key, value] of ignoredSessions) {
    if (value.lastSeenAt < cutoff) {
      ignoredSessions.delete(key);
    }
  }
}

export function markIgnoredSession(params: IgnoredSessionKey): void {
  const now = Date.now();
  const key = buildIgnoredSessionKey(params);
  const existing = ignoredSessions.get(key);
  ignoredSessions.set(key, {
    ...params,
    accountIds: mergeAccountId(existing?.accountIds ?? [], params.accountId),
    ignoredAt: existing?.ignoredAt ?? now,
    lastSeenAt: now,
  });
  cleanupIgnoredSessions(now);
}

export function isIgnoredSession(params: IgnoredSessionKey): boolean {
  const now = Date.now();
  const key = buildIgnoredSessionKey(params);
  const session = ignoredSessions.get(key);
  if (!session) {
    return false;
  }
  if (now - session.lastSeenAt > IGNORED_SESSION_TTL_MS) {
    ignoredSessions.delete(key);
    return false;
  }
  session.accountIds = mergeAccountId(session.accountIds, params.accountId);
  session.accountId = params.accountId;
  session.lastSeenAt = now;
  return true;
}

export function releaseIgnoredSession(params: IgnoredSessionKey): boolean {
  return ignoredSessions.delete(buildIgnoredSessionKey(params));
}
