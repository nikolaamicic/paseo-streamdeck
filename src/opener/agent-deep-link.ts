import { buildAgentDeepLink, parseAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import type { AgentAddress } from "../agents/agent-model.ts";

/**
 * Agent links built by `buildAgentDeepLink` from @getpaseo/protocol 0.15.4:
 * `paseo://h/<serverId>/agent/<agentId>`. The installed Paseo app registers
 * the `paseo` scheme and parses this route, but Paseo's public documentation
 * does not describe it, so whether it opens the
 * exact agent must be confirmed on the device.
 */

/** Real IDs are `srv_…` and UUIDs; this alphabet needs no URL encoding. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LINK_PATTERN =
  /^paseo:\/\/h\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/agent\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

export function isValidAgentId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/**
 * True only for the exact link of `expected`: full-string match, same IDs,
 * and agreement with the protocol parser the Paseo app uses.
 */
export function isAgentDeepLinkFor(url: string, expected: AgentAddress): boolean {
  const match = LINK_PATTERN.exec(url);
  if (match?.[1] !== expected.serverId || match[2] !== expected.agentId) return false;
  const parsed = parseAgentDeepLink(url);
  return parsed?.serverId === expected.serverId && parsed.agentId === expected.agentId;
}

/** Returns the verified link, or null when the address cannot be linked safely. */
export function agentDeepLink(address: AgentAddress): string | null {
  if (!isValidAgentId(address.serverId) || !isValidAgentId(address.agentId)) return null;
  const url = buildAgentDeepLink(address);
  return isAgentDeepLinkFor(url, address) ? url : null;
}
