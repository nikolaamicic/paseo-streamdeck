import type { AgentRecord } from "../agents/agent-model.ts";
import type { ProjectAddress } from "./project-model.ts";
import { workspaceKey, type WorkspaceRecord } from "./workspace-model.ts";

/**
 * Which project an agent belongs to (P1): only through confirmed protocol
 * fields, the agent's `workspaceId` and that workspace's `projectId`, on the
 * same host. Never by display name, project key or path. An agent without a
 * workspace, or whose workspace is not in the observed list, has no known
 * project: it counts only for All projects.
 */

/** The observed workspace list and how complete the two lists are. */
export interface MembershipFacts {
  readonly serverId: string;
  readonly workspaces: readonly WorkspaceRecord[];
  /** The daemon has more workspaces than the observed page. */
  readonly workspacesTruncated: boolean;
  /** The daemon has more agents than the observed page. */
  readonly agentsTruncated: boolean;
}

/** An agent count and whether it may be low: never shown as complete when it is not. */
export interface MemberCount {
  readonly count: number;
  /** True when more members may exist than counted (shown as "N+"). */
  readonly lowerBound: boolean;
}

export type ProjectScope =
  { readonly kind: "all" } | { readonly kind: "project"; readonly address: ProjectAddress };

function workspaceIndex(facts: MembershipFacts): Map<string, WorkspaceRecord> {
  const index = new Map<string, WorkspaceRecord>();
  for (const workspace of facts.workspaces) {
    if (workspace.address.serverId === facts.serverId)
      index.set(workspaceKey(workspace.address), workspace);
  }
  return index;
}

/** The agent's project ID on this host, or null when it cannot be known. */
export function agentProjectId(
  agent: AgentRecord,
  index: ReadonlyMap<string, WorkspaceRecord>,
  serverId: string,
): string | null {
  if (agent.address.serverId !== serverId || agent.workspaceId === null) return null;
  return index.get(workspaceKey({ serverId, workspaceId: agent.workspaceId }))?.projectId ?? null;
}

/** The agents of a scope, in the given order. */
export function agentsInScope(
  agents: readonly AgentRecord[],
  scope: ProjectScope,
  facts: MembershipFacts,
): AgentRecord[] {
  const onHost = agents.filter((agent) => agent.address.serverId === facts.serverId);
  if (scope.kind === "all") return onHost;
  if (scope.address.serverId !== facts.serverId) return [];
  const index = workspaceIndex(facts);
  return onHost.filter(
    (agent) => agentProjectId(agent, index, facts.serverId) === scope.address.projectId,
  );
}

/**
 * How many agents a scope has. All projects may be low only when the agent
 * list is truncated. A project may also be low when the workspace list is
 * truncated and some agent's workspace is not in it: that agent may belong
 * to the project.
 */
export function countInScope(
  agents: readonly AgentRecord[],
  scope: ProjectScope,
  facts: MembershipFacts,
): MemberCount {
  const count = agentsInScope(agents, scope, facts).length;
  if (scope.kind === "all") return { count, lowerBound: facts.agentsTruncated };
  const index = workspaceIndex(facts);
  const unattributed = agents.some(
    (agent) =>
      agent.address.serverId === facts.serverId &&
      agent.workspaceId !== null &&
      !index.has(workspaceKey({ serverId: facts.serverId, workspaceId: agent.workspaceId })),
  );
  return {
    count,
    lowerBound: facts.agentsTruncated || (facts.workspacesTruncated && unattributed),
  };
}
