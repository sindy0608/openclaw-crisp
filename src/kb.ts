import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_UNIFIED_KB_PATH = "/Users/kusamurajyo/.openclaw/workspace/config/crisp-kb-unified.md";

const LEGACY_CMY_FALLBACK = [
  "[客服人格设定]",
  "你现在是影阁，作为 CMYNetwork 的默认客服机器人回复用户。",
  "风格要求：专业、礼貌、清楚、不废话；先解决问题，再解释；不编造、不乱承诺、不擅自承诺退款或赔偿。",
  "如遇支付争议、退款诉求、敏感投诉、账户异常且无法确认、技术问题超出知识库，明确说明需要人工进一步处理。",
  "[站点信息]",
  "官网：https://cmy.network",
  "备用官网：https://newcmy.com",
  "备用官网2：https://cmy4.network",
  "导航：https://gotocmy.com",
  "Wiki：https://caomei.wiki",
  "地址发布：https://github.com/caomeicloud/url",
  "Windows：https://www.caomei.wiki/article-categories/windows/",
  "macOS：https://www.caomei.wiki/article-categories/macos/",
  "Android：https://www.caomei.wiki/article-categories/android/",
  "iPhone/iPad：https://www.caomei.wiki/article-categories/ios/",
  "AppleTV：https://www.caomei.wiki/knowledge-base/shadowrocket-for-appletv/",
  "安卓TV/盒子：https://paolu.lanzouw.com/cmy-andriod-tv",
  "mac 已损坏修复命令：sudo xattr -r -d com.apple.quarantine /Applications/cmynetwork.app",
  "严禁给 CMYNetwork 用户发送 Mielink 链接。",
].join("\n");

const LEGACY_MIELINK_FALLBACK = [
  "[客服人格设定]",
  "你现在是影阁，作为 Mielink 的默认客服机器人回复用户。",
  "风格要求：专业、礼貌、清楚、不废话；先解决问题，再解释；不编造、不乱承诺、不擅自承诺退款或赔偿。",
  "如遇支付争议、退款诉求、敏感投诉、账户异常且无法确认、技术问题超出知识库，明确说明需要人工进一步处理。",
  "[站点信息]",
  "官网1：https://mielink.com",
  "官网2：https://miel.ink",
  "备用地址1：https://miemielink.com",
  "备用地址2：https://portal.mielink.cc",
  "备用地址3：https://mielink.org",
  "备用地址4：https://gomie.link",
  "防丢导航：https://gotomie.com",
  "Wiki：https://www.mielink.wiki",
  "地址发布：https://github.com/yangjuancloud/yj-url",
  "Windows：https://www.mielink.wiki/article-categories/windows/",
  "macOS：https://www.mielink.wiki/article-categories/macos/",
  "Android：https://www.mielink.wiki/article-categories/android/",
  "iPhone/iPad：https://www.mielink.wiki/article-categories/ios/",
  "AppleTV：https://www.mielink.wiki/knowledge-base/shadowrocket-for-appletv/",
  "安卓TV/盒子：https://paolu.lanzouw.com/mielink-andriod-tv",
  "mac 已损坏修复命令：先确认 Mielink 客户端 app 名称，避免误发 CMY 命令。",
  "严禁给 Mielink 用户发送 CMYNetwork 链接。",
].join("\n");

type SiteFlavor = "cmy" | "mielink";

export function resolveUnifiedKnowledgeBasePath(): string {
  return process.env.CRISP_UNIFIED_KB_PATH?.trim() || DEFAULT_UNIFIED_KB_PATH;
}

function inferSiteFlavor(params: {
  accountId: string;
  websiteId: string;
  siteName?: string;
}): SiteFlavor {
  const key = `${params.accountId}:${params.websiteId}:${params.siteName ?? ""}`.toLowerCase();
  return key.includes("site1") || key.includes("cmy") || key.includes("397e7ffa-ba15-4027-a853-be89fa90af51")
    ? "cmy"
    : "mielink";
}

function buildSiteScopeGuard(siteFlavor: SiteFlavor): string {
  if (siteFlavor === "cmy") {
    return [
      "[当前站点]",
      "本次会话属于 CMYNetwork / site1。",
      "只能使用统一知识库中 site1 / CMYNetwork 的信息、链接和规则，严禁混入 Mielink 内容。",
    ].join("\n");
  }

  return [
    "[当前站点]",
    "本次会话属于 Mielink / site2。",
    "只能使用统一知识库中 site2 / Mielink 的信息、链接和规则，严禁混入 CMYNetwork 内容。",
  ].join("\n");
}

async function readUnifiedKnowledgeBase(): Promise<string> {
  try {
    return (await readFile(resolveUnifiedKnowledgeBasePath(), "utf8")).trim();
  } catch {
    return "";
  }
}

export async function buildSupportKnowledge(params: {
  accountId: string;
  websiteId: string;
  siteName?: string;
}): Promise<string> {
  const siteFlavor = inferSiteFlavor(params);
  const unifiedKb = await readUnifiedKnowledgeBase();
  const fallback = siteFlavor === "cmy" ? LEGACY_CMY_FALLBACK : LEGACY_MIELINK_FALLBACK;

  return [buildSiteScopeGuard(siteFlavor), unifiedKb || fallback].join("\n\n");
}

function toBlockQuote(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line.trim() || "(空)"}`)
    .join("\n");
}

function formatTimestamp(now: Date): string {
  return `${now.toISOString()} (${now.toLocaleString("zh-CN", { timeZone: "Asia/Tokyo", hour12: false })} JST)`;
}

export async function appendUnifiedKnowledgeBaseNote(params: {
  accountId: string;
  websiteId: string;
  siteName?: string;
  sessionId: string;
  visitorName: string;
  visitorMessage: string;
  guidance: string;
}): Promise<{ path: string; timestamp: string }> {
  const path = resolveUnifiedKnowledgeBasePath();
  const now = new Date();
  const timestamp = formatTimestamp(now);
  const entry = [
    "",
    "",
    "---",
    "",
    `## 知识补充 ${timestamp}`,
    `- 账号: ${params.accountId}`,
    `- 站点: ${params.siteName || params.websiteId}`,
    `- 会话: ${params.sessionId}`,
    `- 访客: ${params.visitorName}`,
    "- 客户原消息:",
    toBlockQuote(params.visitorMessage),
    "- 操作员补充指导:",
    toBlockQuote(params.guidance),
    "- 说明: 该条目由 Telegram #知识库 指令追加，供后续 Crisp 自动回复与人工润色统一使用。",
    "",
  ].join("\n");

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, entry, "utf8");

  return { path, timestamp };
}
