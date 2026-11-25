/**
 * Plugin-side model of a Paseo workspace, the unit dial 3 selects.
 * Only what the plugin shows or compares is kept;
 * directories, scripts and git data are private and never stored.
 *
 * The status set mirrors @getpaseo/protocol 0.15.4
 * (WorkspaceDescriptorPayloadSchema.status). The model does not depend on the
 * SDK; the Paseo adapter validates daemon data and maps it onto these types.
 */

/** Workspace status buckets (protocol `WorkspaceStateBucketSchema`). */
export const WORKSPACE_STATUSES = [
  "needs_input",
  "failed",
  "running",
  "attention",
  "done",
] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

/** Workspace identity is qualified by the daemon (host) that owns it. */
export interface WorkspaceAddress {
  readonly serverId: string;
  readonly workspaceId: string;
}

export interface WorkspaceRecord {
  readonly address: WorkspaceAddress;
  /** Resolved Paseo name; includes a title the user set in Paseo. Not unique. */
  readonly name: string;
  /**
   * The project this workspace belongs to (protocol `projectId`, required):
   * the only link from workspaces, and through them agents, to a project.
   */
  readonly projectId: string;
  /** Project display name; tells apart workspaces with the same name. */
  readonly projectName: string;
  /** Status as received; may be a value newer than this plugin knows. */
  readonly rawStatus: string;
  readonly status: WorkspaceStatus | "unknown";
  /** True only when the daemon reports a non-empty `archivingAt` string. */
  readonly archiving: boolean;
}

/**
 * Map key for a workspace identity. Both parts are encoded so that IDs
 * containing the separator can never produce the same key for different
 * identities (same scheme as `agentKey`).
 */
export function workspaceKey(address: WorkspaceAddress): string {
  return `${encodeURIComponent(address.serverId)}/${encodeURIComponent(address.workspaceId)}`;
}

export function sameWorkspace(a: WorkspaceAddress, b: WorkspaceAddress): boolean {
  return a.serverId === b.serverId && a.workspaceId === b.workspaceId;
}

/** Field-by-field equality, so unchanged updates do not trigger re-rendering. */
export function workspacesEqual(a: WorkspaceRecord, b: WorkspaceRecord): boolean {
  return (
    sameWorkspace(a.address, b.address) &&
    a.name === b.name &&
    a.projectId === b.projectId &&
    a.projectName === b.projectName &&
    a.rawStatus === b.rawStatus &&
    a.status === b.status &&
    a.archiving === b.archiving
  );
}

/** Returns a frozen copy, detached from the caller's object. */
export function freezeWorkspace(record: WorkspaceRecord): WorkspaceRecord {
  return Object.freeze({
    ...record,
    address: Object.freeze({
      serverId: record.address.serverId,
      workspaceId: record.address.workspaceId,
    }),
  });
}
