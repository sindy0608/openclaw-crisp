import type { PendingReply } from "./pending-replies.js";

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

export function buildApprovalStateText(params: {
  pending: PendingReply;
  status: string;
}): string {
  const { pending, status } = params;
  return [
    `🆕 Crisp 消息 [${pending.id}]`,
    "",
    `🌐 网站: ${pending.siteName || pending.crispWebsiteId}`,
    `👤 访客: ${pending.visitorName}`,
    `💬 ${truncate(pending.visitorMessage, 500)}`,
    "",
    `状态: ${status}`,
  ].join("\n");
}
