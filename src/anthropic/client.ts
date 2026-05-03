import Anthropic from "@anthropic-ai/sdk";
import { type AnthropicEnv, resolveAnthropicEnv } from "./env";

export type AnthropicCtx = {
  client: Anthropic;
  env: AnthropicEnv;
};

export function buildClient(env: AnthropicEnv = resolveAnthropicEnv()): AnthropicCtx {
  const client = new Anthropic({
    apiKey: env.apiKey,
    authToken: env.authToken,
    baseURL: env.baseURL,
    defaultHeaders: env.authToken
      ? { "anthropic-beta": env.betas.join(",") }
      : undefined,
  });
  return { client, env };
}
