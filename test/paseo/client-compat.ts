import type { PaseoClient } from "@getpaseo/client";
import type { AgentFeedClient } from "../../src/paseo/agent-feed.ts";

/**
 * Compile-time check only (not a test file, never executed): the real
 * @getpaseo/client 0.15.4 client must satisfy the subset the feed relies on.
 * `npm run typecheck` fails if the SDK types drift away from it.
 */
export function asAgentFeedClient(client: PaseoClient): AgentFeedClient {
  return client;
}
