# OpenClaw Kimi thinking compatibility patches

These patches apply core fixes to OpenClaw dist files so that Kimi K2.6/K2.7
variant model IDs are recognised as reasoning models and their thinking content
is filtered before reaching Crisp users.

Run after every `openclaw update`:

```bash
bash patches/apply-kimi-compat.sh
openclaw gateway restart
```

Files patched:
- `dist/moonshot-thinking-*.js`
- `dist/openai-transport-stream-*.js`
- `dist/reply-payload-*.js`
