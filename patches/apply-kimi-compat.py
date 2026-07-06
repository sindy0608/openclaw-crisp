#!/usr/bin/env python3
"""
OpenClaw Kimi thinking compatibility patch
=====================================
Applies three core dist patches required for Kimi K2.6/K2.7 models to work
through OpenClaw without leaking internal thinking content into Crisp:

1. moonshot-thinking: recognise K2.6/K2.7 variant model IDs as thinking models.
2. openai-transport-stream: add K2.6/K2.7 variants to the reasoning-content replay set.
3. reply-payload: heuristic Kimi reasoning filter (Chinese/English thinking summary).

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

    return apply_replace(
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


def patch_reply_payload():
    region = "//#region src/plugin-sdk/reply-payload.ts"
    path, content = find_chunk_by_region(region)
    if not path:
        print("reply-payload: chunk not found")
        return False
    print(f"reply-payload: {path}")

    ok = True
    ok &= apply_replace(
        path,
        content,
        old='''const REASONING_PREFIX_RE = /^(?:reasoning:|thinking\\.{0,3}(?=\\s*(?:>\\s*)?_))/u;''',
        new='''const REASONING_PREFIX_RE = /^(?:reasoning:|thinking\\.{0,3}(?=\\s*(?:>\\s*)?_))/u;
const KIMI_REASONING_HEURISTIC_RE = /^(?:\\s*(?:用户反馈|客户反馈|用户问[：:]|用户问[：:]\"|客户问[：:]|客户问[：:]\"|用户询问的是|用户问的是|用户询问|用户问)[\\s\\S]{0,500}|\\s*(?:这通常是|这显然是|这往往是|一般来说这|一般是|这种情况通常|这属于|这看起来是|该问题通常|该情况通常|此类问题通常)[\\s\\S]{0,500}|\\s*(?:The user's latest message is|The user is saying|There's no new question or issue to address|A brief,? [\\w\\s]+ response is appropriate|is appropriate here|I (?:should|will|can|need to) (?:respond|reply|answer)|I should keep|This is(?: a| just)? (?:brief|acknowledgment|confirmation|reminder|note|explanation|summary|overview|analysis)))/iu;''',
        description="Kimi reasoning heuristic regex",
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


def main():
    if not os.path.isdir(DIST_DIR):
        print(f"Error: OpenClaw dist directory not found: {DIST_DIR}")
        sys.exit(1)

    print("Applying OpenClaw Kimi thinking compatibility patches...\n")
    results = []
    results.append(("moonshot-thinking", patch_moonshot_thinking()))
    results.append(("openai-transport-stream", patch_openai_transport_stream()))
    results.append(("reply-payload", patch_reply_payload()))

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
