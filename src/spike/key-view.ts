import type { AgentAddress, AgentRecord } from "../agents/agent-model.ts";
import { sameAddress } from "../agents/agent-model.ts";
import { toDisplayStatus, type DisplayStatus } from "../agents/display-status.ts";
import type { AgentFeedErrorCode } from "../paseo/feed-diagnostics.ts";
import type { LinkState } from "../paseo/link-state.ts";
import type { ConnectionState } from "../connection/connection-model.ts";

/**
 * What an agent key (a slot placed by the navigation) shows, as structured
 * content ("face") that key-svg.ts draws. Pure, so every case is testable without the Stream Deck
 * SDK. Daemon-provided text stays raw here and is sanitized when drawn.
 */

/** Whether the shown agent data is current, and if not, why. */
export type Connection = "live" | "stale" | "offline" | "error";

export type MessageIcon = "dots" | "offline" | "alert" | "empty";

export type KeyFace =
  | {
      readonly kind: "agent";
      readonly status: DisplayStatus;
      readonly title: string | null;
      readonly provider: string;
      readonly project: string | null;
      readonly subagent: boolean;
      readonly archived: boolean;
      readonly connection: Connection;
      /** No longer in the shown workspace; kept in place until a relayout (§6 rule 6). */
      readonly dimmed: boolean;
    }
  | {
      readonly kind: "message";
      readonly icon: MessageIcon;
      /** Fixed English lines, each at most 10 characters. */
      readonly lines: readonly string[];
      /** Drawn on the red error background. */
      readonly alert: boolean;
    };

export interface KeyView {
  /** Identity that a press may open; null when the key shows no agent. */
  readonly identity: AgentAddress | null;
  /** The key offers Retry: a press asks the recovery owner for one attempt. */
  readonly retry: boolean;
  /**
   * Footer scroll position in pixels (UI-1). A drawing parameter only: it is
   * not part of what a press acts on.
   */
  readonly footerOffset: number;
  /** Scroll position of the second title line in pixels (W7); drawing only. */
  readonly titleOffset: number;
  readonly face: KeyFace;
}

/** Feed state every key shows the same way. */
export interface FeedInputs {
  /** The connection (C3a3); only "ok" has a feed to show. */
  readonly connection: ConnectionState;
  readonly link: LinkState["kind"];
  readonly stale: boolean;
  readonly failure: AgentFeedErrorCode | null;
  /** Error of the last failed attempt while the owner recovers (K2). */
  readonly recoveryError: AgentFeedErrorCode | null;
  /** The owner accepts an explicit Retry right now. */
  readonly retryAvailable: boolean;
  /** Server identity of the connected daemon, once known. */
  readonly serverId: string | null;
  /** The feed is ready: both directories applied their first snapshot. */
  readonly hasSnapshot: boolean;
}

/** A slot key (W7): the agent placed on it by the navigation, if any. */
export interface SlotInputs extends FeedInputs {
  /** "loading" until the keys' workspace is resolved; "empty" for no agent. */
  readonly slot: "loading" | "empty" | AgentAddress;
  /** The placed agent left the shown workspace (§6 rule 6). */
  readonly dimmed: boolean;
  /** The placed agent's record from the current directory, if present. */
  readonly record: AgentRecord | undefined;
}

/** Short, readable words for feed errors; codes would be cut mid-word. */
export const ERROR_WORDS: Readonly<Record<AgentFeedErrorCode, string>> = {
  closed: "closed",
  already_started: "internal",
  connect_failed: "connect",
  auth_failed: "auth",
  host_identity_failed: "host ID",
  subscribe_failed: "subscribe",
  start_timeout: "timeout",
  subscription_failed: "subscribe",
  initial_snapshot_invalid: "bad data",
  cleanup_failed: "cleanup",
};

function message(icon: MessageIcon, lines: string[], alert = false, retry = false): KeyView {
  return {
    identity: null,
    retry,
    footerOffset: 0,
    titleOffset: 0,
    face: { kind: "message", icon, lines, alert },
  };
}

/**
 * The connection before any feed: loading, settings that could not be read
 * (a press retries the read), or a source that is not valid. Null when the
 * connection is set and the feed decides.
 */
function connectionMessage(connection: ConnectionState): KeyView | null {
  if (connection === "ok") return null;
  if (connection === "loading") return message("dots", ["Loading"]);
  if (connection === "unavailable") {
    return message("alert", ["Paseo", "settings", "Retry"], true, true);
  }
  // The old connection did not close: no Retry, a plugin restart clears it.
  if (connection === "switch_blocked")
    return message("alert", ["Restart", "Paseo", "plugin"], true);
  return message("alert", ["Paseo", "invalid", "config"], true);
}

/** Connecting, error and Retry messages before the first data; null once ready. */
function feedMessage(input: FeedInputs): KeyView | null {
  if (input.hasSnapshot) return null;
  const error = input.recoveryError ?? input.failure;
  if (error !== null && input.retryAvailable) {
    return message("alert", ["Paseo", ERROR_WORDS[error], "Retry"], true, true);
  }
  if (error !== null) return message("alert", ["Paseo", "error", ERROR_WORDS[error]], true);
  if (input.link === "connecting" || input.link === "idle") {
    return message("dots", ["Paseo", "connecting"]);
  }
  return message("offline", ["Paseo", "not", "connected"]);
}

function connectionOf(input: FeedInputs): Connection {
  const error = input.recoveryError ?? input.failure;
  if (error !== null) return "error";
  if (input.link !== "connected") return "offline";
  return input.stale ? "stale" : "live";
}

function agentView(record: AgentRecord, connection: Connection, dimmed = false): KeyView {
  return {
    identity: record.address,
    retry: false,
    footerOffset: 0,
    titleOffset: 0,
    face: {
      kind: "agent",
      status: toDisplayStatus(record),
      title: record.title,
      provider: record.provider,
      project: record.project?.name ?? null,
      subagent: record.parentAgentId !== null,
      archived: record.archivedAt !== null,
      connection,
      dimmed,
    },
  };
}

/**
 * A slot key shows the agent the navigation placed on it, or nothing. The
 * identity comes from the placement and must match the record's, so a key
 * never shows one agent under another's identity or another host's agent.
 */
export function slotKeyView(input: SlotInputs): KeyView {
  const blocked = connectionMessage(input.connection);
  if (blocked !== null) return blocked;
  const waiting = feedMessage(input);
  if (waiting !== null) return waiting;
  if (input.slot === "loading") return message("dots", ["Loading"]);
  const record = input.record;
  if (
    input.slot === "empty" ||
    record === undefined ||
    !sameAddress(record.address, input.slot) ||
    record.address.serverId !== input.serverId
  ) {
    return message("empty", []);
  }
  return agentView(record, connectionOf(input), input.dimmed);
}

/** Equal views need no new render. Faces are small plain objects. */
export function sameKeyView(a: KeyView, b: KeyView): boolean {
  const sameIdentity =
    a.identity === null || b.identity === null
      ? a.identity === b.identity
      : sameAddress(a.identity, b.identity);
  return (
    sameIdentity &&
    a.retry === b.retry &&
    a.footerOffset === b.footerOffset &&
    a.titleOffset === b.titleOffset &&
    JSON.stringify(a.face) === JSON.stringify(b.face)
  );
}
