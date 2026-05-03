// Resolve Anthropic credentials the same way Claude Code does, so installing
// this CLI on a machine where Claude Code already works requires no extra setup.
//
// Precedence (matches Claude Code behavior):
//   1. ANTHROPIC_API_KEY        — direct API key
//   2. ANTHROPIC_AUTH_TOKEN     — bearer token (custom proxies / OAuth flows)
//   3. ~/.claude/.credentials.json — subscription credentials cache
//
// Optional overrides honored across the same env vars Claude Code reads:
//   ANTHROPIC_BASE_URL, ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL,
//   ANTHROPIC_DEFAULT_HEADERS, ANTHROPIC_BETAS
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AnthropicEnv = {
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  model: string;
  betas: string[];
  source: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" | "claude-credentials";
};

const DEFAULT_MODEL = "claude-sonnet-4-6";

function readClaudeCredentials(): string | undefined {
  try {
    const path = join(homedir(), ".claude", ".credentials.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw?.claudeAiOauth?.accessToken ?? raw?.accessToken;
  } catch {
    return undefined;
  }
}

export function resolveAnthropicEnv(): AnthropicEnv {
  const baseURL = process.env.ANTHROPIC_BASE_URL || undefined;
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const betas = (process.env.ANTHROPIC_BETAS || "computer-use-2025-01-24")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (process.env.ANTHROPIC_API_KEY) {
    return {
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL,
      model,
      betas,
      source: "ANTHROPIC_API_KEY",
    };
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return {
      authToken: process.env.ANTHROPIC_AUTH_TOKEN,
      baseURL,
      model,
      betas,
      source: "ANTHROPIC_AUTH_TOKEN",
    };
  }
  const subscriptionToken = readClaudeCredentials();
  if (subscriptionToken) {
    return {
      authToken: subscriptionToken,
      baseURL,
      model,
      betas,
      source: "claude-credentials",
    };
  }
  throw new Error(
    "No Anthropic credentials found. Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN), " +
      "or sign in with Claude Code so ~/.claude/.credentials.json exists.",
  );
}
