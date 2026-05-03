# open-cua-mac

> Computer Use CLI for macOS — drives your Mac with Anthropic's `computer_20250124` tool, augmented with native Accessibility context. Drop-in compatible with the same env vars Claude Code uses.

```
┌─────────────────┐   computer_20250124    ┌─────────────────┐
│  open-cua-mac   │ ─────────────────────▶ │  Anthropic API  │
│   (Bun + TS)    │ ◀───── tool_use ────── │ (Sonnet/Opus 4) │
└────────┬────────┘                        └─────────────────┘
         │ executes
         ▼
┌──────────────────────────────────────────────────────────┐
│  macOS exec layer                                         │
│   • screencapture  → screenshots (point-resolution)       │
│   • cliclick       → mouse, keyboard                      │
│   • AppleScript    → scroll                               │
│   • AXHelper.swift → Accessibility tree as JSON context   │
└──────────────────────────────────────────────────────────┘
```

## Quick start

```bash
# 1. Tooling (one time)
brew install cliclick
curl -fsSL https://bun.sh/install | bash

# 2. Clone + build the AX helper (Swift, ~3s)
git clone https://github.com/oreasono/open-cua-mac.git
cd open-cua-mac
bun install
bun run build:ax

# 3. Run a task
bun bin/cli.ts run "open Calculator and compute 137 * 42, then tell me the result"
```

The first time you run it, macOS will prompt your terminal for **Accessibility** and **Screen Recording**. Grant both in *System Settings → Privacy & Security*.

## Credentials

`open-cua-mac` reads the same env vars Claude Code reads, in the same order:

| Source                                | Notes                                       |
|---------------------------------------|---------------------------------------------|
| `ANTHROPIC_API_KEY`                   | Direct API key (recommended)                |
| `ANTHROPIC_AUTH_TOKEN`                | Bearer token (custom proxies / OAuth flows) |
| `~/.claude/.credentials.json`         | Subscription token cached by Claude Code    |

Optional overrides also honored:

- `ANTHROPIC_BASE_URL` — point at a custom proxy
- `ANTHROPIC_MODEL` — defaults to `claude-sonnet-4-6`. Use `claude-opus-4-7` for harder UI.
- `ANTHROPIC_BETAS` — defaults to `computer-use-2025-01-24`

If Claude Code already works on this machine, `open-cua-mac` will work too.

## Commands

```text
open-cua-mac run "<task>" [--max-turns N] [--no-ax]
    Run a task end-to-end. Streams each action to stderr; final summary to stdout.

open-cua-mac doctor
    Check tools, permissions, display info, and credential resolution.

open-cua-mac shot <out.png>
    One-shot screenshot at point resolution. Sanity check for Screen Recording perms.

open-cua-mac ax [pid] [--depth N]
    Dump the Accessibility tree of the focused (or given) app as JSON.
```

## Why both Accessibility and pixel-based?

Anthropic's Computer Use is pixel-based: the model sees screenshots and emits coordinates. That works on anything with a screen — but it's slower, costlier in vision tokens, and shaky on fine-grained widgets.

Native macOS apps expose a structured **Accessibility tree** with stable identifiers and frames. `open-cua-mac` dumps a compact summary of that tree on each turn and prefixes it to the user message, so the model targets widgets by semantic identity when it can — and falls back to pure pixel reasoning when it can't (browser canvases, custom rendering, games).

## Status

`v0.1` — pixel exec + AX context injection working end-to-end. Roadmap:

- [ ] AX-driven actions (click by element id) as a separate tool the model can prefer
- [ ] Per-step token / cost reporting
- [ ] Multi-monitor coordinate handling
- [ ] Optional MCP server mode (`open-cua-mac mcp`)
- [ ] Run replay (every turn's screenshot + action saved to `~/.open-cua-mac/runs/`)

## License

MIT — see [`LICENSE`](./LICENSE).

Inspired by [`iFurySt/open-codex-computer-use`](https://github.com/iFurySt/open-codex-computer-use) (Accessibility-only MCP) and Anthropic's [`computer-use-demo`](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo) (pixel-only Linux Docker).
