import { agentKey, type AgentRecord } from "../agents/agent-model.ts";
import { DISPLAY_STATUS_INFO, toDisplayStatus } from "../agents/display-status.ts";
import { compareAgents } from "../navigation/agent-layout.ts";
import type { AgentFeedErrorCode } from "../paseo/feed-diagnostics.ts";
import type { LinkState } from "../paseo/link-state.ts";
import type { ConnectionState } from "../connection/connection-model.ts";

/**
 * Attention dial (dial 4; design approved by the owner with two changes:
 * the agent's name is white, and an empty list that is not current says
 * Offline / Updating, never "No alerts"). Pure, so every case is testable without the Stream Deck SDK.
 *
 * The list holds the current host's non-archived agents whose display
 * status is a question, an approval or an error (toDisplayStatus), sorted
 * by compareAgents. Closed agents never qualify (closed wins in
 * toDisplayStatus); Turn ended, Running, Idle and Unknown are not
 * attention, and nothing is read from account quota. Only the title and
 * project name are shown: never question text, permission inputs, error
 * text or conversation.
 */

/**
 * Empty, current and complete list. Deliberately narrow: the dial covers
 * only structured questions, approvals and errors. An agent that ended its
 * turn waiting for an ordinary chat reply is not detected (Paseo 0.15.4
 * has no signal for it; see the spec), so the text must not say that
 * nothing needs the user.
 */
const NO_ALERTS = "No alerts";
const ALERT_SCOPE = "Questions · approvals · errors";

export type AttentionReason = "awaiting_answer" | "awaiting_permission" | "error";

export interface AttentionItem {
  /** Stable identity (host + agent ID), as agentKey. */
  readonly key: string;
  readonly record: AgentRecord;
  readonly reason: AttentionReason;
}

/** Feed facts the dial needs; the same sources as the keys. */
export interface AttentionFacts {
  /** The connection (C3a3); only "ok" has agents to show. */
  readonly connection: ConnectionState;
  readonly link: LinkState["kind"];
  readonly stale: boolean;
  /** Terminal feed failure or the last recovery attempt's error. */
  readonly failure: AgentFeedErrorCode | null;
  /** Both directories applied their first snapshot. */
  readonly ready: boolean;
  readonly serverId: string | null;
  readonly agents: readonly AgentRecord[];
  /** The agent directory holds only its first page (200 agents). */
  readonly truncated: boolean;
}

function reasonOf(record: AgentRecord): AttentionReason | null {
  const status = toDisplayStatus(record);
  return status === "awaiting_answer" || status === "awaiting_permission" || status === "error"
    ? status
    : null;
}

/** The dial's list, in compareAgents order; empty before the host is known. */
export function attentionItems(facts: AttentionFacts): AttentionItem[] {
  const host = facts.serverId;
  if (host === null) return [];
  return facts.agents
    .filter((record) => record.address.serverId === host && record.archivedAt === null)
    .filter((record) => reasonOf(record) !== null)
    .sort(compareAgents)
    .flatMap((record) => {
      const reason = reasonOf(record);
      return reason === null ? [] : [{ key: agentKey(record.address), record, reason }];
    });
}

/** Position of `key`, or 0 when it is gone or none was chosen. */
export function attentionIndex(items: readonly AttentionItem[], key: string | null): number {
  const index = key === null ? -1 : items.findIndex((item) => item.key === key);
  return Math.max(0, index);
}

/** Color roles; the Elgato UI maps them to concrete colors. */
export type AttentionInk = "question" | "error" | "white" | "calm" | "muted";

export interface AttentionDisplay {
  readonly label: string;
  readonly labelInk: AttentionInk;
  /** "2/5", "2/5+" for a partial list; empty without items. */
  readonly counter: string;
  readonly value: string;
  readonly valueInk: AttentionInk;
  readonly hint: string;
  /** The agent a press may open; null when none is shown. */
  readonly target: string | null;
}

function message(value: string, hint: string, valueInk: AttentionInk = "muted"): AttentionDisplay {
  return {
    label: "Attention",
    labelInk: "muted",
    counter: "",
    value,
    valueInk,
    hint,
    target: null,
  };
}

/** Why the shown data is not current; null when it is. */
function notCurrent(facts: AttentionFacts, errorWord: (code: AgentFeedErrorCode) => string) {
  if (facts.failure !== null) {
    return {
      value: "Paseo error",
      hint: `Reason: ${errorWord(facts.failure)}`,
      mark: "Paseo error · last known",
    };
  }
  if (facts.link !== "connected") {
    return { value: "Offline", hint: "No current data", mark: "Offline · last known" };
  }
  if (facts.stale) {
    return { value: "Updating…", hint: "No current data", mark: "Updating… · last known" };
  }
  return null;
}

/**
 * The dial's display for the item at `index` (clamped). States are checked
 * in order: configuration, no first data (error, loading, offline), then
 * the list, which is marked "last known" and greyed while not current.
 */
export function attentionDisplay(
  facts: AttentionFacts,
  index: number,
  errorWord: (code: AgentFeedErrorCode) => string,
): AttentionDisplay {
  if (facts.connection === "loading") return message("Loading…", "");
  if (facts.connection === "unavailable") {
    return message("Paseo error", "Settings unavailable", "error");
  }
  if (facts.connection === "invalid") return message("Paseo error", "Reason: config", "error");
  if (facts.connection === "switch_blocked") {
    return message("Paseo error", "Restart the plugin", "error");
  }
  const stateNow = notCurrent(facts, errorWord);
  if (!facts.ready) {
    if (facts.failure !== null) return message("Paseo error", stateNow?.hint ?? "", "error");
    // Connected but still waiting for the first snapshots is loading, not offline.
    if (facts.link === "connecting" || facts.link === "idle" || facts.link === "connected") {
      return message("Loading…", "");
    }
    return message("Offline", "No agent data yet");
  }
  // Without a known host nothing can be claimed about the list.
  if (facts.serverId === null) return message("Loading…", "");
  const items = attentionItems(facts);
  if (items.length === 0) {
    if (stateNow !== null) {
      return message(stateNow.value, stateNow.hint, facts.failure !== null ? "error" : "muted");
    }
    if (facts.truncated) {
      return message("None in first 200", "More agents exist · not checked", "calm");
    }
    return message(NO_ALERTS, ALERT_SCOPE, "calm");
  }
  const position = Math.min(Math.max(0, index), items.length - 1);
  const item = items[position];
  if (item === undefined) return message(NO_ALERTS, ALERT_SCOPE, "calm");
  const project = item.record.project?.name ?? null;
  const live = stateNow === null;
  let hint: string;
  if (!live) hint = stateNow.mark;
  else if (facts.truncated)
    hint = `First 200 agents only${project === null ? "" : ` · ${project}`}`;
  else hint = project === null ? "Press to open" : `Press to open · ${project}`;
  return {
    label: DISPLAY_STATUS_INFO[item.reason].label,
    labelInk: !live ? "muted" : item.reason === "error" ? "error" : "question",
    counter: `${position + 1}/${items.length}${facts.truncated ? "+" : ""}`,
    value: item.record.title ?? "(untitled)",
    valueInk: live ? "white" : "muted",
    hint,
    target: item.key,
  };
}
