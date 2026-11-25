import type { AgentRecord } from "./agent-model.ts";

/**
 * Normalized status for presentation. Every value has a defined API source;
 * the rules below apply in this order.
 */
export type DisplayStatus =
  | "awaiting_answer"
  | "awaiting_permission"
  | "error"
  | "starting"
  | "running"
  | "turn_ended"
  | "idle"
  | "closed"
  | "unknown";

/** Colors and icons are drawn by the Elgato UI (key-svg.ts, STATUS_STYLE). */
export interface DisplayStatusInfo {
  readonly label: string;
}

/**
 * User-facing labels are English (the owner's decision, 2026-11-15) and short
 * enough for one Stream Deck key line (10 characters).
 */
export const DISPLAY_STATUS_INFO: Readonly<Record<DisplayStatus, DisplayStatusInfo>> = {
  awaiting_answer: { label: "Question?" },
  awaiting_permission: { label: "Approval?" },
  error: { label: "Error" },
  starting: { label: "Starting" },
  running: { label: "Running" },
  // Not "Finished": daemon 0.15.4 marks every ended turn the same way,
  // including failed ones and provider-limit replies (spec §4).
  turn_ended: { label: "Turn ended" },
  idle: { label: "Idle" },
  closed: { label: "Closed" },
  unknown: { label: "Unknown" },
};

/**
 * The first matching rule wins. Pending permissions are the only source of
 * "waiting"; `idle` alone never means the agent waits for the user. Attention
 * reasons describe the last finished turn, so they only refine `idle`: the
 * daemon was observed to keep a previous `finished` reason briefly after a new
 * turn started; `error` is treated the same way.
 */
export function toDisplayStatus(agent: AgentRecord): DisplayStatus {
  if (agent.status === "closed") return "closed";
  if (agent.pendingPermissionKinds.includes("question")) return "awaiting_answer";
  if (agent.pendingPermissionKinds.length > 0) return "awaiting_permission";
  switch (agent.status) {
    case "error":
      return "error";
    case "running":
      return "running";
    case "initializing":
      return "starting";
    case "idle":
      if (agent.requiresAttention && agent.attentionReason === "error") return "error";
      // The daemon recorded a failed turn (turn_failed); cleared with the next turn.
      if (agent.lastTurnFailed) return "error";
      // An ended turn, not proof of success: 0.15.4 sets "finished" on every
      // running → idle transition, so it is shown without a success colour.
      if (agent.requiresAttention && agent.attentionReason === "finished") return "turn_ended";
      return "idle";
    case "unknown":
      return "unknown";
  }
}
