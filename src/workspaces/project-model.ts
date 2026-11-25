/**
 * Plugin-side model of a Paseo project (P1): the
 * group the Paseo sidebar shows above its workspaces. Identity is the
 * daemon (host) plus the protocol `projectId`; the display name is never an
 * identity, two projects may share it. Only what the plugin shows or
 * compares is kept; root paths and icons are private and never stored.
 */

export interface ProjectAddress {
  readonly serverId: string;
  readonly projectId: string;
}

export interface ProjectRecord {
  readonly address: ProjectAddress;
  /** Resolved name (`projectDisplayName`, includes a user rename). Not unique. */
  readonly name: string;
}

/** Map key for a project identity; both parts encoded, as `workspaceKey`. */
export function projectKey(address: ProjectAddress): string {
  return `${encodeURIComponent(address.serverId)}/${encodeURIComponent(address.projectId)}`;
}

export function sameProject(a: ProjectAddress, b: ProjectAddress): boolean {
  return a.serverId === b.serverId && a.projectId === b.projectId;
}

export function projectsEqual(a: ProjectRecord, b: ProjectRecord): boolean {
  return sameProject(a.address, b.address) && a.name === b.name;
}
