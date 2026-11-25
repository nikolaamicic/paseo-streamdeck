/**
 * Plugin-side model of a Paseo agent. Paseo's unit is the *agent*; the plugin
 * treats one agent as one openable item. Raw API values are kept next to the
 * normalized ones so the UI never has to guess what the daemon reported.
 *
 * The value sets mirror @getpaseo/protocol 0.15.4. The model does not depend on the SDK; the
 * Paseo adapter validates daemon data and maps it onto these types.
 */

/** Lifecycle statuses (protocol `AGENT_LIFECYCLE_STATUSES`). */
export const AGENT_STATUSES = ["initializing", "idle", "running", "error", "closed"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Attention reasons (protocol `AgentSnapshotPayloadSchema.attentionReason`). */
export const ATTENTION_REASONS = ["finished", "error", "permission"] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** Pending permission kinds (protocol `AgentPermissionRequestPayloadSchema.kind`). */
export const PERMISSION_KINDS = ["tool", "plan", "question", "mode", "other"] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

/** Agent identity is qualified by the daemon (host) that owns it. */
export interface AgentAddress {
  readonly serverId: string;
  readonly agentId: string;
}

export interface AgentProject {
  /** Stable project key from the daemon's directory entry. */
  readonly key: string;
  readonly name: string;
}

export interface AgentRecord {
  readonly address: AgentAddress;
  /** Provider ID exactly as reported, e.g. "claude" or "codex". */
  readonly provider: string;
  readonly title: string | null;
  /** Lifecycle status as received; may be a value newer than this plugin knows. */
  readonly rawStatus: string;
  readonly status: AgentStatus | "unknown";
  /** Kinds of currently pending permission requests; request contents are never kept. */
  readonly pendingPermissionKinds: readonly PermissionKind[];
  readonly requiresAttention: boolean;
  readonly attentionReason: AttentionReason | null;
  /**
   * The daemon recorded a failed last turn (`lastError`, set on turn_failed
   * and cleared when the next turn starts or completes). Only presence is
   * kept: the error text may contain conversation details and is never stored.
   */
  readonly lastTurnFailed: boolean;
  /** Archiving is separate from the lifecycle: a `closed` agent is not archived. */
  readonly archivedAt: string | null;
  /** `null` when the daemon reports no project; never guessed from paths. */
  readonly project: AgentProject | null;
  /**
   * Current workspace placement (can change over time); `null` when the daemon
   * reports none. Never derived from `cwd`, the project or a name.
   */
  readonly workspaceId: string | null;
  /** Set when Paseo labels mark this agent as delegated by another agent. */
  readonly parentAgentId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Map key for an agent identity. Both parts are encoded so that IDs containing
 * the separator can never produce the same key for different identities.
 */
export function agentKey(address: AgentAddress): string {
  return `${encodeURIComponent(address.serverId)}/${encodeURIComponent(address.agentId)}`;
}

export function sameAddress(a: AgentAddress, b: AgentAddress): boolean {
  return a.serverId === b.serverId && a.agentId === b.agentId;
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Field-by-field equality, so unchanged updates do not trigger re-rendering. */
export function recordsEqual(a: AgentRecord, b: AgentRecord): boolean {
  return (
    sameAddress(a.address, b.address) &&
    a.provider === b.provider &&
    a.title === b.title &&
    a.rawStatus === b.rawStatus &&
    a.status === b.status &&
    sameList(a.pendingPermissionKinds, b.pendingPermissionKinds) &&
    a.requiresAttention === b.requiresAttention &&
    a.attentionReason === b.attentionReason &&
    a.lastTurnFailed === b.lastTurnFailed &&
    a.archivedAt === b.archivedAt &&
    a.project?.key === b.project?.key &&
    a.project?.name === b.project?.name &&
    a.workspaceId === b.workspaceId &&
    a.parentAgentId === b.parentAgentId &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt
  );
}

/**
 * Returns a deeply frozen copy. Stored records are shared with renderers, so
 * neither the caller's later edits nor a consumer can change them in place.
 */
export function freezeRecord(record: AgentRecord): AgentRecord {
  return Object.freeze({
    ...record,
    address: Object.freeze({ serverId: record.address.serverId, agentId: record.address.agentId }),
    pendingPermissionKinds: Object.freeze([...record.pendingPermissionKinds]),
    project:
      record.project === null
        ? null
        : Object.freeze({ key: record.project.key, name: record.project.name }),
  });
}
