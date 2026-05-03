// Pixel-level executor for macOS.
//
// Anthropic's computer_20250124 tool emits actions in a virtual coordinate
// space whose size we declare in the tool definition (display_width_px /
// display_height_px). We pick the actual main-display point size as that
// declared resolution, so 1:1 mapping holds and we never have to scale.
//
// Screenshots are captured with `screencapture` and downscaled to point
// resolution to keep token cost predictable on Retina.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

export type DisplayInfo = {
  // Logical (point) size — what we expose to the model.
  point: Size;
  // Physical pixel size — what screencapture captures by default on Retina.
  pixel: Size;
  scale: number;
};

function run(cmd: string, args: string[], opts: { input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

export async function getDisplayInfo(): Promise<DisplayInfo> {
  // system_profiler is slow (~1s) but reliable. Cache after first call.
  if (cachedDisplay) return cachedDisplay;
  const script = `
    tell application "Finder"
      set b to bounds of window of desktop
      return (item 3 of b as string) & "x" & (item 4 of b as string)
    end tell
  `;
  const { stdout } = await run("osascript", ["-e", script]);
  const dims = stdout.trim().split("x").map((n) => parseInt(n, 10));
  const w = dims[0] ?? 1440;
  const h = dims[1] ?? 900;
  // Probe pixel size via a tiny screencapture
  const probe = join(tmpdir(), `ocu-probe-${randomUUID()}.png`);
  await run("screencapture", ["-x", "-T", "0", probe]);
  const sips = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", probe]);
  await unlink(probe).catch(() => {});
  const pw = parseInt(sips.stdout.match(/pixelWidth: (\d+)/)?.[1] ?? `${w}`, 10);
  const ph = parseInt(sips.stdout.match(/pixelHeight: (\d+)/)?.[1] ?? `${h}`, 10);
  const result: DisplayInfo = {
    point: { width: w, height: h },
    pixel: { width: pw, height: ph },
    scale: pw / w,
  };
  cachedDisplay = result;
  return result;
}
let cachedDisplay: DisplayInfo | undefined;

export async function screenshotPng(): Promise<Buffer> {
  const display = await getDisplayInfo();
  const path = join(tmpdir(), `ocu-shot-${randomUUID()}.png`);
  await run("screencapture", ["-x", "-T", "0", path]);
  // Downscale to point resolution so model coordinates match what we send back.
  if (display.scale !== 1) {
    await run("sips", [
      "-z",
      String(display.point.height),
      String(display.point.width),
      path,
    ]);
  }
  const buf = await readFile(path);
  await unlink(path).catch(() => {});
  return buf;
}

export async function moveMouse(p: Point) {
  await run("cliclick", [`m:${p.x},${p.y}`]);
}

export async function leftClick(p: Point) {
  await run("cliclick", [`c:${p.x},${p.y}`]);
}

export async function rightClick(p: Point) {
  await run("cliclick", [`rc:${p.x},${p.y}`]);
}

export async function middleClick(p: Point) {
  // cliclick has no native middle-click; emulate via a no-op for now.
  await run("cliclick", [`c:${p.x},${p.y}`]);
}

export async function doubleClick(p: Point) {
  await run("cliclick", [`dc:${p.x},${p.y}`]);
}

export async function leftMouseDown(p: Point) {
  await run("cliclick", [`dd:${p.x},${p.y}`]);
}

export async function leftMouseUp(p: Point) {
  await run("cliclick", [`du:${p.x},${p.y}`]);
}

export async function dragTo(from: Point, to: Point) {
  await run("cliclick", [`dd:${from.x},${from.y}`, `du:${to.x},${to.y}`]);
}

export async function typeText(text: string) {
  await run("cliclick", ["-w", "20", `t:${text}`]);
}

// Translate Anthropic xdotool-style key combo (e.g. "cmd+shift+t", "Return")
// into cliclick key syntax. cliclick uses kp:<name> and kd/ku for modifiers.
const KEY_MAP: Record<string, string> = {
  return: "return",
  enter: "return",
  tab: "tab",
  space: "space",
  escape: "esc",
  esc: "esc",
  backspace: "delete",
  delete: "fwd-delete",
  up: "arrow-up",
  down: "arrow-down",
  left: "arrow-left",
  right: "arrow-right",
  home: "home",
  end: "end",
  pageup: "page-up",
  pagedown: "page-down",
};
const MOD_MAP: Record<string, string> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

export async function pressKey(combo: string) {
  const parts = combo.toLowerCase().split("+").map((s) => s.trim());
  const mods: string[] = [];
  let key: string | undefined;
  for (const p of parts) {
    if (MOD_MAP[p]) mods.push(MOD_MAP[p]);
    else key = KEY_MAP[p] ?? p;
  }
  if (!key) return;
  const args: string[] = [];
  for (const m of mods) args.push(`kd:${m}`);
  // single-char keys go through `t:`, named keys through `kp:`
  if (key.length === 1) args.push(`t:${key}`);
  else args.push(`kp:${key}`);
  for (const m of mods.reverse()) args.push(`ku:${m}`);
  await run("cliclick", args);
}

export async function scroll(p: Point, dx: number, dy: number) {
  // cliclick has no scroll; fall back to AppleScript via System Events.
  await moveMouse(p);
  const lines = Math.round(Math.abs(dy));
  const direction = dy > 0 ? "down" : "up";
  if (lines > 0) {
    const script = `tell application "System Events" to repeat ${lines} times
      key code ${direction === "down" ? 125 : 126}
    end repeat`;
    await run("osascript", ["-e", script]);
  }
  // Horizontal scroll left as TODO — rare in computer-use traces.
  void dx;
}

export async function wait(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export async function cursorPosition(): Promise<Point> {
  const { stdout } = await run("cliclick", ["p"]);
  const m = stdout.trim().match(/(-?\d+),(-?\d+)/);
  if (!m) return { x: 0, y: 0 };
  return { x: parseInt(m[1] ?? "0", 10), y: parseInt(m[2] ?? "0", 10) };
}
