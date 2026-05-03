// Thin TS wrapper around the Swift AXHelper binary.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN_RELEASE = join(HERE, "..", "..", "swift-helper", ".build", "release", "AXHelper");
const BIN_DEBUG = join(HERE, "..", "..", "swift-helper", ".build", "debug", "AXHelper");

function helperPath(): string {
  if (existsSync(BIN_RELEASE)) return BIN_RELEASE;
  if (existsSync(BIN_DEBUG)) return BIN_DEBUG;
  throw new Error(
    "AXHelper binary not found. Run `bun run build:ax` (or `swift build --package-path swift-helper -c release`).",
  );
}

function call<T>(args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath(), args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", () => {
      if (stderr.trim()) {
        try {
          const parsed = JSON.parse(stderr);
          return reject(new Error(parsed.error || stderr));
        } catch {
          return reject(new Error(stderr.trim()));
        }
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch (e) {
        reject(new Error(`AXHelper non-JSON output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

export type AppInfo = { pid: number; name: string; bundle: string; active: boolean };
export type AXNode = {
  id: string;
  role: string;
  title?: string;
  value?: string;
  desc?: string;
  help?: string;
  frame?: { x: number; y: number; w: number; h: number };
  enabled?: boolean;
  children?: AXNode[];
};

export const ax = {
  apps: () => call<AppInfo[]>(["apps"]),
  tree: (pid?: number, maxDepth = 12) =>
    pid != null
      ? call<AXNode>(["tree", String(pid), String(maxDepth)])
      : call<AXNode>(["tree", String(maxDepth)]),
  focus: (pid: number) => call<{ ok: true }>(["focus", String(pid)]),
  click: (pid: number, id: string) => call<{ ok: true }>(["click", String(pid), id]),
  set: (pid: number, id: string, value: string) =>
    call<{ ok: true }>(["set", String(pid), id, value]),
};
