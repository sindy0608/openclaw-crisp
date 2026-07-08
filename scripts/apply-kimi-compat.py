#!/usr/bin/env python3
"""OpenClaw Kimi thinking compatibility patch
=====================================
Applies core dist patches required for Kimi K2.6/K2.7 models to work
through OpenClaw without leaking internal thinking content or fallback
notices into Crisp customer-facing channels.

The script is idempotent: running it on an already-patched install does nothing.
Run after every `openclaw update` (or `npm install -g openclaw`) before restarting
`openclaw gateway`.

Usage:
    python3 ~/.openclaw/apply-kimi-compat.py
    # or
    bash ~/.openclaw/apply-kimi-compat.sh
"""
import glob
import os
import sys

DIST_DIR = "/opt/homebrew/lib/node_modules/openclaw/dist"


def find_chunk_by_region(region_marker):
    for path in glob.glob(os.path.join(DIST_DIR, "*.js")):
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        if region_marker in content:
            return path, content
    return None, None


def find_chunk_by_text(substring):
    for path in glob.glob(os.path.join(DIST_DIR, "*.js")):
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        if substring in content:
            return path, content
    return None, None


def apply_replace(path, content, old, new, description):
    """Idempotent text replacement. Tolerates the patch already being applied."""
    if new in content:
        print(f"  ✓ {description} already applied")
        return True
    if old not in content:
        print(f"  ✗ {description} could not find original text to replace")
        return False
    content = content.replace(old, new, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"  ✓ {description} applied")
    return True


def patch_kimi_catalog():
    catalog_path = "/Users/kusamurajyo/.openclaw/agents/yingge/plugins/kimi/catalog.json"
    if not os.path.exists(catalog_path):
        print("kimi-catalog: catalog.json not found")
        return False
    print(f"kimi-catalog: {catalog_path}")
    with open(catalog_path, "r", encoding="utf-8") as f:
        content = f.read()
    if '"id": "kimi-k2.7-code"' not in content:
        print("  ✗ K2.7 model not found in catalog")
        return False
    if '"reasoning": true' in content:
        print("  ✓ K2.7 reasoning flag already true")
        return True
    if '"reasoning": false' not in content:
        print("  ✗ K2.7 reasoning flag not boolean false; manual review needed")
        return False
    return apply_replace(
        catalog_path,
        content,
        old='''"id": "kimi-k2.7-code",\n          "name": "K2.7 Code",\n          "reasoning": false''',
        new='''"id": "kimi-k2.7-code",\n          "name": "K2.7 Code",\n          "reasoning": true''',
        description="Keep K2.7 reasoning flag enabled in catalog",
    )


def patch_moonshot_thinking():
    region = "//#region src/llm/providers/stream-wrappers/moonshot-thinking.ts"
    path, content = find_chunk_by_region(region)
    if not path:
        print("moonshot-thinking: chunk not found")
        return False
    print(f"moonshot-thinking: {path}")

    ok = True
    ok &= apply_replace(
        path,
        content,
        old='''const MOONSHOT_THINKING_KEEP_MODEL_ID = "kimi-k2.6";
const MOONSHOT_ALWAYS_THINKING_MODEL_ID = "kimi-k2.7-code";''',
        new='''const MOONSHOT_THINKING_KEEP_MODEL_IDS = new Set([
  "kimi-k2.6",
  "k2.6-code-preview",
  "kimi-k2.6-code-preview",
  "K2.6-code-preview"
]);
const MOONSHOT_ALWAYS_THINKING_MODEL_IDS = new Set([
  "kimi-k2.7-code",
  "k2.7-code",
  "K2.7-code-preview",
  "kimi-k2.7-code-preview"
]);''',
        description="thinking model ID sets",
    )

    # Re-read because content may have changed
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    ok &= apply_replace(
        path,
        content,
        old='''const isKimiK27 = modelId === MOONSHOT_ALWAYS_THINKING_MODEL_ID;
		const streamModel = isKimiK27 ? {''',
        new='''const isKimiK27 = MOONSHOT_ALWAYS_THINKING_MODEL_IDS.has(modelId);
		const isKimiK26Keep = MOONSHOT_THINKING_KEEP_MODEL_IDS.has(modelId);
		const streamModel = (isKimiK27 || isKimiK26Keep) ? {''',
        description="K2.7/K2.6 detection in wrapper",
    )

    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    ok &= apply_replace(
        path,
        content,
        old='''if (payloadModelId === MOONSHOT_ALWAYS_THINKING_MODEL_ID) {''',
        new='''if (MOONSHOT_ALWAYS_THINKING_MODEL_IDS.has(payloadModelId)) {''',
        description="payload model always-thinking check",
    )

    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    ok &= apply_replace(
        path,
        content,
        old='''const isKeepCapableModel = payloadModelId === MOONSHOT_THINKING_KEEP_MODEL_ID;''',
        new='''const isKeepCapableModel = MOONSHOT_THINKING_KEEP_MODEL_IDS.has(payloadModelId);''',
        description="keep-capable model check",
    )
    return ok


def patch_openai_transport_stream():
    marker = "REASONING_CONTENT_REPLAY_MODEL_IDS"
    path, content = find_chunk_by_text(marker)
    if not path:
        print("openai-transport-stream: chunk not found")
        return False
    print(f"openai-transport-stream: {path}")

    ok = True
    ok &= apply_replace(
        path,
        content,
        old='''\t"kimi-k2.6",
\t"kimi-k2.7-code",
\t"kimi-k2-thinking",''',
        new='''\t"kimi-k2.6",
\t"k2.6-code-preview",
\t"kimi-k2.6-code-preview",
\t"K2.6-code-preview",
\t"kimi-k2.7-code",
\t"k2.7-code",
\t"K2.7-code-preview",
\t"kimi-k2-thinking",''',
        description="add K2.6/K2.7 variants to replay set",
    )

    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    ok &= apply_replace(
        path,
        content,
        old='''function applyQwenOpenAICompletionsThinkingParams(params) {
\tif (!params.modelReasoning || !isQwenOpenAICompletionsThinkingFormat(params.compatThinkingFormat)) return false;
\tconst enabled = isOpenAICompletionsThinkingEnabled(params.requestedEffort);
\tif (params.compatThinkingFormat === "qwen-chat-template") setQwenChatTemplateThinking(params.payload, enabled);
\telse params.payload.enable_thinking = enabled;
\treturn true;
}''',
        new='''function applyQwenOpenAICompletionsThinkingParams(params) {
\tif (!params.modelReasoning || !isQwenOpenAICompletionsThinkingFormat(params.compatThinkingFormat)) return false;
\t// Kimi: force disable enable_thinking to prevent internal reasoning from leaking into plain content.
\t// See https://platform.kimi.com/docs/guide/use-kimi-k2-thinking-model
\tconst enabled = false;
\tif (params.compatThinkingFormat === "qwen-chat-template") setQwenChatTemplateThinking(params.payload, enabled);
\telse params.payload.enable_thinking = enabled;
\treturn true;
}''',
        description="force disable Kimi enable_thinking to prevent reasoning leakage",
    )
    return ok


def patch_reply_payload():
    region = "//#region src/plugin-sdk/reply-payload.ts"
    path, content = find_chunk_by_region(region)
    if not path:
        print("reply-payload: chunk not found")
        return False
    print(f"reply-payload: {path}")

    # If already patched (idempotency), just confirm and continue. The full regex
    # is too long for a literal "new in content" check after minification, so check
    # for the constant declaration directly.
    if "const KIMI_REASONING_HEURISTIC_RE" in content:
        # Verify the detection wiring is also in place.
        if "if (KIMI_REASONING_HEURISTIC_RE.test(normalized)) return true;" in content:
            print("  ✓ Kimi reasoning heuristic regex (Chinese + English monologue) already applied")
            return True

    ok = True
    ok &= apply_replace(
        path,
        content,
        old='''const REASONING_PREFIX_RE = /^(?:reasoning:|thinking\\.{0,3}(?=\\s*(?:>\\s*)?_))/u;''',
        new='''const REASONING_PREFIX_RE = /^(?:reasoning:|thinking\\.{0,3}(?=\\s*(?:>\\s*)?_))/u;
const KIMI_REASONING_HEURISTIC_RE = /^(?:\\s*(?:用户反馈|客户反馈|用户问[：:]|用户问[：:]"|客户问[：:]|客户问[：:]"|用户询问的是|用户问的是|用户询问|用户问|根据上下文|但是根据上下文|结合上下文|用户消息是|用户连续发送|用户再次发送|用户发送了|用户说了|用户问的是|用户询问的是|这意味着|这表示客户想要|这种请求意味着|我应该|我已经回复过|让我再次确认|我应该|我需要|我可以|让我看看|让我确认|让我再次|让我组织|让我保持|让我梳理|让我列出|最合理的做法|实际上我应该|实际上我需要|但实际上|考虑到.*通常|回顾对话历史|简洁回复即可|简短回复即可|直接回复即可|回复要点|输出要点|不输出任何分析|根据知识库|按照知识库|结合上下文|结合历史对话|根据最新客户消息)[\\s\\S]{0,500}|\\s*(?:这通常是|这显然是|这往往是|一般来说这|一般是|这种情况通常|这属于|这看起来是|该问题通常|该情况通常|此类问题通常)[\\s\\S]{0,500}|\\s*(?:The user said|The user is asking|The user is reporting|The user might be|The customer said|The customer is asking|The customer might be|Looking at the context|Looking at the knowledge base|Looking at the conversation|Actually,|Wait, I should|Wait, I need|I need to check|I should provide guidance|I should just answer|I think the user|In summary|Based on the context|Based on the knowledge base|From the knowledge base|According to the knowledge base|This is(?: a| just)? (?:brief|acknowledgment|confirmation|reminder|note|explanation|summary|overview|analysis|standard|common|typical|user question|customer question|question from the user))[ \\t\\S]{0,500}|\\s*(?:The user's latest message is|The user is saying|There's no new question or issue to address|A brief,? [\\w\\s]+ response is appropriate|is appropriate here|I (?:should|will|can|need to) (?:respond|reply|answer)|I should keep|This is(?: a| just)? (?:brief|acknowledgment|confirmation|reminder|note|explanation|summary|overview|analysis)))/iu;''',
        description="Kimi reasoning heuristic regex (Chinese + English monologue)",
    )

    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    ok &= apply_replace(
        path,
        content,
        old='''if (REASONING_PREFIX_RE.test(normalized)) return true;
	const unquoted = normalizeLowercaseStringOrEmpty(trimLeadingMarkdownQuoteMarkers(text));
	return REASONING_PREFIX_RE.test(unquoted);''',
        new='''if (REASONING_PREFIX_RE.test(normalized)) return true;
	if (KIMI_REASONING_HEURISTIC_RE.test(normalized)) return true;
	const unquoted = normalizeLowercaseStringOrEmpty(trimLeadingMarkdownQuoteMarkers(text));
	if (REASONING_PREFIX_RE.test(unquoted)) return true;
	return KIMI_REASONING_HEURISTIC_RE.test(unquoted);''',
        description="use heuristic regex in reasoning detection",
    )
    return ok


def patch_fallback_notice_suppression():
    marker = "fallbackNoticePayloads"
    path, content = find_chunk_by_text(marker)
    if not path:
        print("fallback-notice-suppression: chunk not found")
        return False
    print(f"fallback-notice-suppression: {path}")

    ok = True
    ok &= apply_replace(
        path,
        content,
        old='''			// Crisp customer-facing channel: never expose model fallback notices to visitors.\n			const fallbackNotice = null;''',
        new='''			// Crisp customer-facing channel: never expose model fallback notices to visitors.\n			const fallbackNotice = null;''',
        description="suppress fallback notice to customer (already null)",
    )
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    ok &= apply_replace(
        path,
        content,
        old='''			// Crisp customer-facing channel: also suppress fallback-cleared notice.\n			// fallbackNoticePayloads.push(...);''',
        new='''			// Crisp customer-facing channel: also suppress fallback-cleared notice.\n			// fallbackNoticePayloads.push(...);''',
        description="suppress fallback-cleared notice to customer (already commented)",
    )
    return ok


def main():
    if not os.path.isdir(DIST_DIR):
        print(f"Error: OpenClaw dist directory not found: {DIST_DIR}")
        sys.exit(1)

    print("Applying OpenClaw Kimi thinking compatibility patches...\n")
    results = []
    results.append(("kimi-catalog", patch_kimi_catalog()))
    results.append(("moonshot-thinking", patch_moonshot_thinking()))
    results.append(("openai-transport-stream", patch_openai_transport_stream()))
    results.append(("reply-payload", patch_reply_payload()))
    results.append(("fallback-notice-suppression", patch_fallback_notice_suppression()))

    print("\nSummary:")
    all_ok = True
    for name, ok in results:
        status = "OK" if ok else "FAILED"
        print(f"  {name}: {status}")
        all_ok &= ok

    if not all_ok:
        sys.exit(1)
    print("\nAll patches applied. Restart OpenClaw gateway to load changes:")
    print("  openclaw gateway restart")


if __name__ == "__main__":
    main()
