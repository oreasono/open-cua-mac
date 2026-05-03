// End-to-end agent loop:
//
//   user task ─▶ Anthropic Messages API (computer_20250124 tool)
//                  │
//                  ├─ tool_use(action) ─▶ execute via macOS pixel exec
//                  │                       (AX context optionally injected)
//                  └─ stop ─▶ return final text
//
// AX is used as *context* on each turn: we dump the focused app's tree and
// pass a compressed summary as a user-message prefix. This lets the model
// target widgets by semantic identity instead of pure pixel guessing — and
// when AX dump fails (e.g. browser content), we fall back to pure vision.

import type Anthropic from "@anthropic-ai/sdk";
import { buildClient, type AnthropicCtx } from "../anthropic/client";
import {
  doubleClick,
  dragTo,
  getDisplayInfo,
  leftClick,
  leftMouseDown,
  leftMouseUp,
  middleClick,
  moveMouse,
  pressKey,
  rightClick,
  screenshotPng,
  scroll,
  typeText,
  wait,
  cursorPosition,
  type Point,
} from "../exec/macos";
import { ax, type AXNode } from "../ax/client";

export type RunOptions = {
  task: string;
  maxTurns?: number;
  systemHint?: string;
  onTurn?: (turn: number, blocks: Anthropic.Messages.ContentBlock[]) => void;
  onAction?: (action: string, input: any) => void;
  enableAxContext?: boolean;
};

export type RunResult = {
  finalText: string;
  turns: number;
  stopReason: string | null;
};

const SYSTEM = `You are operating a macOS computer through a screenshot + click interface.

Conventions:
- Coordinates you return are in display POINTS (not Retina pixels). The screenshot you see has been resampled to point resolution; click those coordinates verbatim.
- Wait briefly after window-changing actions (cmd+tab, app launch, dialog dismiss) — call the wait action with ~500ms before screenshotting.
- Prefer keyboard shortcuts (cmd+space → Spotlight, cmd+tab, cmd+w) over hunting menus when faster.
- When the task is complete, stop and reply in plain text describing what you did. Do not loop endlessly.
`;

function summarizeAX(node: AXNode, depth = 0, lines: string[] = []): string[] {
  // Compact one-line summary per node, skipping pure containers with no label.
  const label = node.title || node.value || node.desc || node.help;
  const interesting = label || node.role.match(/Button|TextField|TextArea|Link|MenuItem|Checkbox|RadioButton|PopUpButton|Cell/);
  if (interesting) {
    const fr = node.frame;
    const pos = fr ? ` @${Math.round(fr.x)},${Math.round(fr.y)} ${Math.round(fr.w)}x${Math.round(fr.h)}` : "";
    lines.push(`${"  ".repeat(depth)}${node.role}${label ? ` "${label.slice(0, 60)}"` : ""}${pos}`);
  }
  if (node.children && lines.length < 200) {
    for (const c of node.children) summarizeAX(c, depth + 1, lines);
  }
  return lines;
}

async function buildAxContext(): Promise<string | null> {
  try {
    const apps = await ax.apps();
    const active = apps.find((a) => a.active);
    if (!active) return null;
    const tree = await ax.tree(active.pid, 10);
    const summary = summarizeAX(tree).slice(0, 80).join("\n");
    return `Focused app: ${active.name} (pid ${active.pid})\nAccessibility tree (truncated):\n${summary}`;
  } catch {
    return null;
  }
}

async function executeAction(input: any, onAction?: RunOptions["onAction"]): Promise<{ kind: "screenshot"; png: Buffer } | { kind: "text"; text: string }> {
  const action = input?.action as string;
  onAction?.(action, input);
  const coord: Point | undefined = Array.isArray(input?.coordinate)
    ? { x: Math.round(input.coordinate[0]), y: Math.round(input.coordinate[1]) }
    : undefined;

  switch (action) {
    case "screenshot":
      return { kind: "screenshot", png: await screenshotPng() };
    case "left_click":
      if (coord) await leftClick(coord);
      return { kind: "screenshot", png: await screenshotPng() };
    case "right_click":
      if (coord) await rightClick(coord);
      return { kind: "screenshot", png: await screenshotPng() };
    case "middle_click":
      if (coord) await middleClick(coord);
      return { kind: "screenshot", png: await screenshotPng() };
    case "double_click":
      if (coord) await doubleClick(coord);
      return { kind: "screenshot", png: await screenshotPng() };
    case "triple_click":
      // emulate triple-click as 3x click — cliclick has no native triple
      if (coord) {
        await leftClick(coord);
        await leftClick(coord);
        await leftClick(coord);
      }
      return { kind: "screenshot", png: await screenshotPng() };
    case "mouse_move":
      if (coord) await moveMouse(coord);
      return { kind: "screenshot", png: await screenshotPng() };
    case "left_mouse_down":
      if (coord) await leftMouseDown(coord);
      return { kind: "text", text: "ok" };
    case "left_mouse_up":
      if (coord) await leftMouseUp(coord);
      return { kind: "text", text: "ok" };
    case "left_click_drag": {
      const start = Array.isArray(input?.start_coordinate)
        ? { x: Math.round(input.start_coordinate[0]), y: Math.round(input.start_coordinate[1]) }
        : await cursorPosition();
      if (coord) await dragTo(start, coord);
      return { kind: "screenshot", png: await screenshotPng() };
    }
    case "key":
      if (typeof input?.text === "string") await pressKey(input.text);
      return { kind: "screenshot", png: await screenshotPng() };
    case "hold_key":
      // Hold-then-release within a single tool call. Approximate: press once.
      if (typeof input?.text === "string") await pressKey(input.text);
      return { kind: "screenshot", png: await screenshotPng() };
    case "type":
      if (typeof input?.text === "string") await typeText(input.text);
      return { kind: "screenshot", png: await screenshotPng() };
    case "scroll": {
      const dir = input?.scroll_direction as string | undefined;
      const amt = (input?.scroll_amount as number | undefined) ?? 3;
      const dy = dir === "down" ? amt : dir === "up" ? -amt : 0;
      const dx = dir === "right" ? amt : dir === "left" ? -amt : 0;
      const at = coord ?? (await cursorPosition());
      await scroll(at, dx, dy);
      return { kind: "screenshot", png: await screenshotPng() };
    }
    case "wait": {
      const ms = (input?.duration as number | undefined) ?? 1;
      await wait(ms < 100 ? ms * 1000 : ms);
      return { kind: "screenshot", png: await screenshotPng() };
    }
    case "cursor_position": {
      const p = await cursorPosition();
      return { kind: "text", text: `${p.x},${p.y}` };
    }
    default:
      return { kind: "text", text: `unknown action: ${action}` };
  }
}

export async function runTask(opts: RunOptions, ctx: AnthropicCtx = buildClient()): Promise<RunResult> {
  const { client, env } = ctx;
  const display = await getDisplayInfo();
  const maxTurns = opts.maxTurns ?? 30;

  const tools: Anthropic.Messages.ToolUnion[] = [
    {
      type: "computer_20250124",
      name: "computer",
      display_width_px: display.point.width,
      display_height_px: display.point.height,
      display_number: 1,
    } as any,
  ];

  const system = opts.systemHint ? `${SYSTEM}\n\n${opts.systemHint}` : SYSTEM;
  const messages: Anthropic.Messages.MessageParam[] = [];

  // Seed: task + optional AX context.
  const axCtx = opts.enableAxContext === false ? null : await buildAxContext();
  messages.push({
    role: "user",
    content: axCtx ? `${opts.task}\n\n---\n${axCtx}` : opts.task,
  });

  let stopReason: string | null = null;
  let finalText = "";

  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await client.beta.messages.create({
      model: env.model,
      max_tokens: 4096,
      system,
      tools: tools as any,
      messages: messages as any,
      betas: env.betas,
    });

    opts.onTurn?.(turn, resp.content as unknown as Anthropic.Messages.ContentBlock[]);
    stopReason = resp.stop_reason;

    const assistantBlocks = resp.content;
    messages.push({ role: "assistant", content: assistantBlocks as any });

    if (resp.stop_reason !== "tool_use") {
      finalText = assistantBlocks
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { finalText, turns: turn + 1, stopReason };
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of assistantBlocks) {
      if (block.type !== "tool_use") continue;
      const result = await executeAction(block.input, opts.onAction);
      if (result.kind === "screenshot") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: result.png.toString("base64"),
              },
            },
          ],
        });
      } else {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.text,
        });
      }
    }
    messages.push({ role: "user", content: toolResults as any });
  }

  return { finalText, turns: maxTurns, stopReason };
}
