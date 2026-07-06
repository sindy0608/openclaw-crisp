import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { crispPlugin } from "./channel.js";

describe("crisp channel outbound", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      if (String(input).includes("/message")) {
        return new Response(JSON.stringify({ error: false, data: { fingerprint: 3003 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("suppresses internal reasoning text instead of sending a customer-visible fallback", async () => {
    const websiteId = "123e4567-e89b-12d3-a456-426614174000";
    const result = await crispPlugin.outbound.sendText({
      cfg: {
        channels: {
          crisp: {
            accounts: {
              site1: {
                websiteId,
                apiKeyId: "key-id",
                apiKeySecret: "key-secret",
                webhookSecret: "1234567890abcdef",
              },
            },
          },
        },
      },
      to: `crisp:site1:${websiteId}:session_123`,
      text: "Reasoning: Native reasoning was produced; no summary text was returned.",
    });

    expect(result).toMatchObject({ channel: "crisp", ok: true, messageId: "suppressed-empty" });
    const messageCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes("/message"));
    expect(messageCall).toBeUndefined();
  });
});
