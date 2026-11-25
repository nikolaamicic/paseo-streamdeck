import type { AgentRecord } from "../agents/agent-model.ts";
import {
  agentsInScope,
  countInScope,
  type MemberCount,
  type MembershipFacts,
} from "./project-membership.ts";
import {
  projectKey,
  sameProject,
  type ProjectAddress,
  type ProjectRecord,
} from "./project-model.ts";
import type { StartIn } from "./start-in-settings.ts";
import type { WorkspaceAddress, WorkspaceRecord } from "./workspace-model.ts";

/**
 * The first dial's selection (P2): all agents of
 * the host, or the agents of one project identified by host and project ID,
 * never by name or position. "unresolved" is a saved Start in that cannot
 * be resolved on this host: it shows no agents and says so, so it is never
 * silently All or another project. Pure logic; the dial, its inspector and
 * storage are separate units.
 */
export type UnresolvedReason =
  /** The saved Start in belongs to another Paseo host. */
  | "other_host"
  /** A version 1 workspace beyond the observed (truncated) workspace page. */
  | "not_in_list"
  /** A version 1 workspace that is no longer listed. */
  | "removed";

/** What a user can choose: All, or one project. */
export type ChosenSelection =
  { readonly kind: "all" } | { readonly kind: "project"; readonly address: ProjectAddress };

export type ProjectSelection =
  ChosenSelection | { readonly kind: "unresolved"; readonly reason: UnresolvedReason };

export const ALL_PROJECTS: ChosenSelection = Object.freeze({ kind: "all" });

export function selectProject(address: ProjectAddress): ChosenSelection {
  return Object.freeze({
    kind: "project",
    address: Object.freeze({ serverId: address.serverId, projectId: address.projectId }),
  });
}

function unresolved(reason: UnresolvedReason): ProjectSelection {
  return Object.freeze({ kind: "unresolved", reason });
}

export function sameSelection(a: ProjectSelection, b: ProjectSelection): boolean {
  if (a.kind === "project" && b.kind === "project") return sameProject(a.address, b.address);
  if (a.kind === "unresolved" && b.kind === "unresolved") return a.reason === b.reason;
  return a.kind === b.kind;
}

/** A stable key; "all" and "unresolved" cannot collide with an encoded project key. */
export function selectionKey(selection: ProjectSelection): string {
  if (selection.kind === "project") return projectKey(selection.address);
  return selection.kind;
}

/** The agents a selection shows, in the given order; none while unresolved. */
export function agentsInSelection(
  agents: readonly AgentRecord[],
  selection: ProjectSelection,
  facts: MembershipFacts,
): AgentRecord[] {
  if (selection.kind === "unresolved") return [];
  return agentsInScope(agents, selection, facts);
}

export function countInSelection(
  agents: readonly AgentRecord[],
  selection: ProjectSelection,
  facts: MembershipFacts,
): MemberCount {
  if (selection.kind === "unresolved") return { count: 0, lowerBound: false };
  return countInScope(agents, selection, facts);
}

/**
 * Projects by name with a fixed English collator (case-insensitive,
 * numeric), so the order does not depend on the system locale; the project
 * ID makes it total, and two projects of the same name stay apart.
 */
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function compareProjects(a: ProjectRecord, b: ProjectRecord): number {
  return (
    collator.compare(a.name, b.name) ||
    (a.address.projectId < b.address.projectId
      ? -1
      : a.address.projectId > b.address.projectId
        ? 1
        : 0)
  );
}

/** The dial's list: All first, then the host's projects in a stable order. */
export function selectionList(
  projects: readonly ProjectRecord[],
  serverId: string,
): ChosenSelection[] {
  return [
    ALL_PROJECTS,
    ...projects
      .filter((project) => project.address.serverId === serverId)
      .sort(compareProjects)
      .map((project) => selectProject(project.address)),
  ];
}

/**
 * Moves `ticks` places through the list and wraps at both ends. A selection
 * that is not in the list (a removed project, or an unresolved Start in)
 * moves from All's position.
 */
export function stepSelection(
  list: readonly ChosenSelection[],
  current: ProjectSelection,
  ticks: number,
): ProjectSelection {
  if (list.length === 0 || !Number.isInteger(ticks)) return current;
  const index = list.findIndex((entry) => sameSelection(entry, current));
  if (index < 0 && ticks === 0) return current;
  const from = Math.max(index, 0);
  const next = (((from + ticks) % list.length) + list.length) % list.length;
  return list[next] ?? current;
}

/** The project record a selection names on its host; none for All or unresolved. */
export function findSelectedProject(
  projects: readonly ProjectRecord[],
  selection: ProjectSelection,
): ProjectRecord | undefined {
  if (selection.kind !== "project") return undefined;
  return projects.find((project) => sameProject(project.address, selection.address));
}

/** What resolving a Start in needs from the ready feed. */
export interface ResolveContext {
  readonly serverId: string;
  /** The workspace page holds only part of the host's workspaces. */
  readonly workspacesTruncated: boolean;
  workspace(address: WorkspaceAddress): WorkspaceRecord | undefined;
}

/**
 * The selection a saved Start in means on the connected host. A project
 * is selected by its ID on its own host, also while the project list does
 * not name it yet (the strip says so). A version 1 workspace is resolved
 * only through the current host's workspace → project link; otherwise it
 * stays visibly unresolved. The saved value itself is never changed.
 */
export function resolveStartIn(startIn: StartIn, context: ResolveContext): ProjectSelection {
  if (startIn.kind === "all") return ALL_PROJECTS;
  if (startIn.address.serverId !== context.serverId) return unresolved("other_host");
  if (startIn.kind === "project") return selectProject(startIn.address);
  const workspace = context.workspace(startIn.address);
  if (workspace === undefined) {
    return unresolved(context.workspacesTruncated ? "not_in_list" : "removed");
  }
  return selectProject({ serverId: context.serverId, projectId: workspace.projectId });
}

/** The feed state a choice follows. */
export interface ChoiceSource {
  /** Both directories applied a first snapshot (cumulative over hosts). */
  readonly ready: boolean;
  /**
   * Either directory is not current. After a host change the feed keeps this
   * true until both directories applied a snapshot of the new host.
   */
  readonly stale: boolean;
  readonly serverId: string | null;
  readonly workspacesTruncated: boolean;
  workspace(address: WorkspaceAddress): WorkspaceRecord | undefined;
}

/** The facts a choice is resolved against (navigation and inspector facts). */
export interface ChoiceFacts {
  readonly ready: boolean;
  readonly stale: boolean;
  readonly serverId: string | null;
  readonly workspaces: readonly WorkspaceRecord[];
  /** The workspace page holds only part of the host's workspaces. */
  readonly truncated: boolean;
}

/** A choice source over a facts snapshot; workspaces are found by host and ID. */
export function choiceSourceOf(facts: ChoiceFacts): ChoiceSource {
  return {
    ready: facts.ready,
    stale: facts.stale,
    serverId: facts.serverId,
    workspacesTruncated: facts.truncated,
    workspace: (address) =>
      facts.workspaces.find(
        (workspace) =>
          workspace.address.serverId === address.serverId &&
          workspace.address.workspaceId === address.workspaceId,
      ),
  };
}

/**
 * The current selection of one dial. A host is resolved from Start in only
 * once its data is ready and fresh; until then the selection is null
 * ("Loading"), also right after a host change, so the previous host's
 * choice is never presented as valid. An unresolved Start in is tried again
 * on later syncs of the same host (a version 1 workspace may still appear),
 * but only until the user confirms a choice: a late automatic resolution
 * never replaces it. An ordinary reconnect to the same host keeps the
 * selection.
 */
export class ProjectChoice {
  private readonly startIn: StartIn;
  private current: ProjectSelection | null = null;
  private resolvedFor: string | null = null;

  constructor(startIn: StartIn) {
    this.startIn = startIn;
  }

  /** Null until resolved; consumers show "Loading" meanwhile. */
  get selection(): ProjectSelection | null {
    return this.current;
  }

  /** Call after feed changes. Returns true when the selection changed. */
  sync(source: ChoiceSource): boolean {
    if (source.serverId === null) return false;
    const sameHost = source.serverId === this.resolvedFor;
    // Only an unresolved Start in is tried again on the same host. A user
    // choice is never unresolved, so a late resolution cannot replace it.
    if (sameHost && this.current?.kind !== "unresolved") return false;
    if (!source.ready || source.stale) {
      if (sameHost) return false;
      // A first or new host whose directories are not both current yet.
      const changed = this.current !== null;
      this.current = null;
      this.resolvedFor = null;
      return changed;
    }
    const serverId = source.serverId;
    const next = resolveStartIn(this.startIn, {
      serverId,
      workspacesTruncated: source.workspacesTruncated,
      workspace: (address) => source.workspace(address),
    });
    const changed = this.current === null || !sameSelection(this.current, next);
    this.current = next;
    this.resolvedFor = serverId;
    return changed;
  }

  /**
   * A user choice (the dial's press). Ignored before resolution and for a
   * project of another host. Returns true when the selection changed.
   */
  choose(selection: ChosenSelection): boolean {
    if (this.current === null || this.resolvedFor === null) return false;
    if (selection.kind === "project" && selection.address.serverId !== this.resolvedFor) {
      return false;
    }
    if (sameSelection(this.current, selection)) return false;
    this.current = selection.kind === "all" ? ALL_PROJECTS : selectProject(selection.address);
    return true;
  }
}
