/**
 * Telegram Notification Helper
 * 
 * Sends approval notifications directly to Telegram.
 */

interface TelegramNotifyOptions {
  botToken: string;
  chatId: string;
  threadId?: string | number;
  pendingId: string;
  siteName: string;
  visitorName: string;
  visitorMessage: string;
  mediaUrl?: string;
}

/**
 * Send a Crisp message notification to Telegram with inline buttons
 */
export async function sendTelegramNotification(opts: TelegramNotifyOptions): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const { botToken, chatId, threadId, pendingId, siteName, visitorName, visitorMessage, mediaUrl } = opts;
  const normalizedThreadId = normalizeThreadId(threadId);

  const mediaBlock = mediaUrl
    ? `🖼 *图片链接:* ${escapeMarkdown(mediaUrl)}\n`
    : "";

  const text = `🆕 *新的 Crisp 消息* \\[${pendingId}\\]\n\n` +
    `🌐 *网站:* ${escapeMarkdown(siteName)}\n` +
    `👤 *访客:* ${escapeMarkdown(visitorName)}\n` +
    `💬 "${escapeMarkdown(visitorMessage)}"\n` +
    mediaBlock +
    `\n_直接回复这条消息即可发送回复，也可以使用下方按钮\\._`;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        ...(normalizedThreadId !== undefined ? { message_thread_id: normalizedThreadId } : {}),
        text,
        parse_mode: "MarkdownV2",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "❌ 忽略", callback_data: `crisp_ignore_${pendingId}` },
              { text: "🫴 托管", callback_data: `crisp_takeover_${pendingId}` },
            ],
          ],
        },
      }),
    });

    const data = await response.json() as { ok: boolean; result?: { message_id: number }; description?: string };

    if (!data.ok) {
      console.error(`[crisp] Telegram API error:`, data);
      return { ok: false, error: data.description || "Unknown error" };
    }

    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    console.error(`[crisp] Failed to send Telegram notification:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Escape special characters for Telegram MarkdownV2
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function normalizeThreadId(threadId: string | number | undefined): number | undefined {
  if (threadId === undefined || threadId === null) {
    return undefined;
  }
  const parsed = Number(threadId);
  return Number.isFinite(parsed) ? parsed : undefined;
}
