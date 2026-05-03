#!/usr/bin/env bun
// open-cua-mac — Computer Use CLI for macOS
//
//   open-cua-mac run "<task>"   Run a task end-to-end via Anthropic computer use
//   open-cua-mac doctor          Check tools and permissions
//   open-cua-mac shot <out.png>  Take a screenshot (sanity check)
//   open-cua-mac ax <pid?>       Dump AX tree of focused (or given) app
//
// Credentials are inherited from the same env vars Claude Code uses.
import { buildClient } from "../src/anthropic/client";
import { runTask } from "../src/agent/loop";
import { ax } from "../src/ax/client";
import { getDisplayInfo, screenshotPng } from "../src/exec/macos";
import { writeFileSync } from "node:fs";
import { resolveAnthropicEnv } from "../src/anthropic/env";

const argv = process.argv.slice(2);
const cmd = argv[0];

function usage(code = 0): never {
  console.log(`open-cua-mac — Computer Use CLI for macOS

Usage:
  open-cua-mac run "<task>" [--max-turns N] [--no-ax]
  open-cua-mac doctor
  open-cua-mac shot <out.png>
  open-cua-mac ax [pid] [--depth N]

Credentials: reads ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL
the same way Claude Code does. Falls back to ~/.claude/.credentials.json.

Model defaults to claude-sonnet-4-6. Override with ANTHROPIC_MODEL.
`);
  process.exit(code);
}

async function cmdDoctor() {
  const checks: Array<[string, () => Promise<string>]> = [
    ["bun", async () => process.versions.bun ?? "unknown"],
    ["macOS display", async () => {
      const d = await getDisplayInfo();
      return `point ${d.point.width}x${d.point.height}, pixel ${d.pixel.width}x${d.pixel.height}, scale ${d.scale}`;
    }],
    ["cliclick", async () => {
      const proc = Bun.spawn(["cliclick", "-V"], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      const out = await new Response(proc.stdout).text();
      return out.trim() || "ok";
    }],
    ["screencapture", async () => {
      const proc = Bun.spawn(["which", "screencapture"], { stdout: "pipe" });
      await proc.exited;
      return (await new Response(proc.stdout).text()).trim();
    }],
    ["AXHelper", async () => {
      try {
        const apps = await ax.apps();
        return `ok (${apps.length} regular apps)`;
      } catch (e: any) {
        return `MISSING — run \`bun run build:ax\`. (${e.message})`;
      }
    }],
    ["Anthropic creds", async () => {
      const e = resolveAnthropicEnv();
      return `${e.source}, model=${e.model}${e.baseURL ? `, baseURL=${e.baseURL}` : ""}`;
    }],
  ];
  let allGood = true;
  for (const [name, fn] of checks) {
    try {
      const res = await fn();
      console.log(`✓ ${name.padEnd(18)} ${res}`);
    } catch (e: any) {
      allGood = false;
      console.log(`✗ ${name.padEnd(18)} ${e.message}`);
    }
  }
  console.log(
    `\nReminder: macOS will prompt for Accessibility + Screen Recording the first\n` +
      `time the AX helper / screencapture run. Grant both for the terminal app you\n` +
      `launch open-cua-mac from (Terminal, iTerm, Ghostty, etc.) in System Settings.`,
  );
  process.exit(allGood ? 0 : 1);
}

async function cmdRun(args: string[]) {
  const positional: string[] = [];
  let maxTurns: number | undefined;
  let enableAx = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--max-turns") {
      maxTurns = parseInt(args[++i] ?? "30", 10);
    } else if (a === "--no-ax") {
      enableAx = false;
    } else if (a !== undefined) {
      positional.push(a);
    }
  }
  const task = positional.join(" ").trim();
  if (!task) usage(1);

  const ctx = buildClient();
  console.error(`[open-cua-mac] model=${ctx.env.model} source=${ctx.env.source}`);
  console.error(`[open-cua-mac] task: ${task}`);

  const result = await runTask(
    {
      task,
      maxTurns,
      enableAxContext: enableAx,
      onAction: (action, input) => {
        const detail =
          action === "type" || action === "key"
            ? ` ${JSON.stringify(input.text).slice(0, 60)}`
            : input?.coordinate
              ? ` @${input.coordinate.join(",")}`
              : "";
        console.error(`  • ${action}${detail}`);
      },
    },
    ctx,
  );
  console.error(`[open-cua-mac] done in ${result.turns} turns (stop=${result.stopReason})`);
  if (result.finalText) console.log(result.finalText);
}

async function cmdShot(args: string[]) {
  const out = args[0];
  if (!out) usage(1);
  const png = await screenshotPng();
  writeFileSync(out, png);
  const d = await getDisplayInfo();
  console.log(`saved ${png.length} bytes → ${out} (${d.point.width}x${d.point.height})`);
}

async function cmdAx(args: string[]) {
  let pid: number | undefined;
  let depth = 12;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--depth") depth = parseInt(args[++i] ?? "12", 10);
    else if (a !== undefined && /^\d+$/.test(a)) pid = parseInt(a, 10);
  }
  const tree = await ax.tree(pid, depth);
  console.log(JSON.stringify(tree, null, 2));
}

(async () => {
  try {
    switch (cmd) {
      case "run":
        await cmdRun(argv.slice(1));
        break;
      case "doctor":
        await cmdDoctor();
        break;
      case "shot":
        await cmdShot(argv.slice(1));
        break;
      case "ax":
        await cmdAx(argv.slice(1));
        break;
      case undefined:
      case "-h":
      case "--help":
        usage(0);
      default:
        console.error(`unknown command: ${cmd}`);
        usage(1);
    }
  } catch (e: any) {
    console.error(`error: ${e.message ?? e}`);
    process.exit(1);
  }
})();
