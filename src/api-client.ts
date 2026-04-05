/**
 * Crisp REST API Client
 */

import {
  buildCrispApiUrl,
  DEFAULT_TIMEOUT_MS,
  type CrispConversation,
  type CrispConversationListItem,
  type CrispMessage,
  type CrispSendMessageParams,
} from "./types.js";

export interface CrispApiClientOptions {
  apiKeyId: string;
  apiKeySecret: string;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableCrispError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  return /429 Too Many Requests|rate_limited|5\d\d/.test(text);
}

function normalizeCrispSessionId(sessionId: string): string {
  return sessionId.startsWith('crisp:') ? sessionId.slice('crisp:'.length) : sessionId;
}

export interface CrispApiClient {
  /**
   * Send a message to a Crisp conversation
   */
  sendMessage(params: CrispSendMessageParams): Promise<{ fingerprint: number; type?: string; from?: string; origin?: string; content?: string }>;

  /**
   * List conversations for a website
   */
  listConversations(
    websiteId: string,
    opts?: { state?: "pending" | "unresolved" | "resolved"; limit?: number; page?: number }
  ): Promise<CrispConversationListItem[]>;

  /**
   * Get conversation details
   */
  getConversation(websiteId: string, sessionId: string): Promise<CrispConversation>;

  /**
   * Get messages from a conversation
   */
  getMessages(
    websiteId: string,
    sessionId: string,
    opts?: { limit?: number }
  ): Promise<CrispMessage[]>;

  /**
   * Update conversation state (resolve/unresolve)
   */
  updateConversationState(
    websiteId: string,
    sessionId: string,
    state: "resolved" | "unresolved"
  ): Promise<void>;

  /**
   * Probe a website to test API connectivity and credentials
   */
  probeWebsite(
    websiteId: string
  ): Promise<{ ok: true; website: { name: string; domain: string } } | { ok: false; error: string }>;
}

/**
 * Create a Crisp API client
 */
export function createCrispClient(opts: CrispApiClientOptions): CrispApiClient {
  const { apiKeyId, apiKeySecret, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  // Build Basic Auth header
  const authHeader = `Basic ${Buffer.from(`${apiKeyId}:${apiKeySecret}`).toString("base64")}`;

  async function crispFetch<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const url = buildCrispApiUrl(path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          "X-Crisp-Tier": "plugin",
          ...init.headers,
        },
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
          `Crisp API error: ${response.status} ${response.statusText} - ${errorBody}`
        );
      }

      const json = await response.json() as { error?: boolean; reason?: string; data?: T };
      
      // Crisp wraps responses in { error: boolean, data: T }
      if (json.error) {
        throw new Error(`Crisp API error: ${json.reason || "Unknown error"}`);
      }

      return json.data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async sendMessage(params: CrispSendMessageParams) {
      const { websiteId, content, type = "text" } = params;
      const sessionId = normalizeCrispSessionId(params.sessionId);
      const path = `/website/${websiteId}/conversation/${sessionId}/message`;

      const body = {
        type,
        content,
        from: "operator",
        origin: "chat",
      };

      const maxAttempts = 3;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          if (attempt > 1) {
            const backoffMs = 350 * attempt;
            console.warn(`[crisp] 🔁 sendMessage retry attempt=${attempt}/${maxAttempts} session=${sessionId} website=${websiteId} backoffMs=${backoffMs}`);
            await sleep(backoffMs);
          }
          const response = await crispFetch<{ fingerprint: number; type?: string; from?: string; origin?: string; content?: string }>(path, {
            method: "POST",
            body: JSON.stringify(body),
          });

          return {
            fingerprint: response.fingerprint,
            type: response.type,
            from: response.from,
            origin: response.origin,
            content: response.content,
          };
        } catch (err) {
          lastError = err;
          const retryable = isRetryableCrispError(err);
          console.warn(`[crisp] ⚠️ sendMessage failed attempt=${attempt}/${maxAttempts} session=${sessionId} website=${websiteId} retryable=${retryable}: ${err instanceof Error ? err.message : String(err)}`);
          if (!retryable || attempt === maxAttempts) {
            throw err;
          }
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },

    async listConversations(websiteId: string, opts?: { state?: "pending" | "unresolved" | "resolved"; limit?: number; page?: number }) {
      const state = opts?.state ?? "unresolved";
      const limit = opts?.limit ?? 20;
      const page = opts?.page ?? 1;
      const path = `/website/${websiteId}/conversations?state=${encodeURIComponent(state)}&limit=${limit}&page=${page}`;
      return crispFetch<CrispConversationListItem[]>(path);
    },

    async getConversation(websiteId: string, sessionId: string) {
      const path = `/website/${websiteId}/conversation/${sessionId}`;
      return crispFetch<CrispConversation>(path);
    },

    async getMessages(
      websiteId: string,
      sessionId: string,
      opts?: { limit?: number }
    ) {
      const limit = opts?.limit ?? 20;
      const path = `/website/${websiteId}/conversation/${sessionId}/messages?limit=${limit}`;
      return crispFetch<CrispMessage[]>(path);
    },

    async updateConversationState(
      websiteId: string,
      sessionId: string,
      state: "resolved" | "unresolved"
    ) {
      const path = `/website/${websiteId}/conversation/${sessionId}/state`;
      await crispFetch<void>(path, {
        method: "PATCH",
        body: JSON.stringify({ state }),
      });
    },

    async probeWebsite(websiteId: string) {
      try {
        const data = await crispFetch<{ name: string; domain: string }>(
          `/website/${websiteId}`
        );
        return { ok: true as const, website: { name: data.name, domain: data.domain } };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
