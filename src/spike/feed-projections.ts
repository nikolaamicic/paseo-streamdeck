import type { AgentDirectory } from "../agents/agent-directory.ts";
import type { AttentionFacts } from "../attention/attention-view.ts";
import type { NavigationFacts } from "../navigation/navigation.ts";
import type { AgentFeed } from "../paseo/agent-feed.ts";
import type { RecoveryState } from "../paseo/feed-recovery.ts";
import type { ProjectsState } from "../paseo/project-sync.ts";
import type { UsageSource } from "../usage/usage-poller.ts";
import type { FeedInputs } from "./key-view.ts";
import type { ConnectionState } from "../connection/connection-model.ts";
import type { ConnectionView } from "./feed-lifecycle.ts";
import type { InspectorFacts } from "./workspace-inspector.ts";

/**
 * The plugin's projections of feed and recovery state for each consumer,
 * moved from plugin.ts unchanged so they can be tested (M4). Each keeps its
 * own shape on purpose: keys keep feed failure and recovery error apart,
 * while the inspector and Attention prefer the recovery error; navigation
 * and the inspector use the workspace page's truncation, Attention the
 * agent page's. They are not merged into one "current" state here.
 */

/** What the projections read from the feed (AgentFeed). */
export type ProjectedFeed = Pick<
  AgentFeed,
  | "linkState"
  | "stale"
  | "failure"
  | "serverId"
  | "ready"
  | "truncated"
  | "workspacesTruncated"
  | "projects"
  | "retryProjects"
  | "connectionEpoch"
  | "workspaceList"
  | "listUsage"
> & { readonly directory: Pick<AgentDirectory, "get" | "list"> };

/** What the projections read from the recovery owner (FeedRecovery). */
export interface ProjectedRecovery {
  readonly feed: ProjectedFeed | null;
  readonly state: RecoveryState;
  readonly retryAvailable: boolean;
}

/**
 * The plugin's connection and the recovery owner (null before a feed
 * started), as the lifecycle's source() gives them. The legacy file's E1
 * target stays internal to the lifecycle, where it only takes part in
 * choosing the address; no view reads it.
 */
export interface ProjectionSource {
  readonly connection: ConnectionView;
  readonly recovery: ProjectedRecovery | null;
}

/** The connection as every view shows it. */
export function connectionState(connection: ConnectionView): ConnectionState {
  if (connection.kind === "active") return "ok";
  // While the old connection closes nothing is current: shown as loading.
  if (connection.kind === "loading" || connection.kind === "switching") return "loading";
  if (connection.kind === "switch_blocked") return "switch_blocked";
  return connection.reason === "settings_unavailable" ? "unavailable" : "invalid";
}

export function feedInputs({ connection, recovery }: ProjectionSource): FeedInputs {
  const feed = recovery?.feed ?? null;
  const state = recovery?.state;
  return {
    connection: connectionState(connection),
    link: feed?.linkState.kind ?? "idle",
    stale: feed?.stale ?? false,
    failure: feed?.failure ?? null,
    recoveryError: state !== undefined && "error" in state ? state.error : null,
    retryAvailable: recovery?.retryAvailable ?? false,
    serverId: feed?.serverId ?? null,
    // Both directories must have their first snapshot; partial data is not shown.
    hasSnapshot: feed?.ready ?? false,
  };
}

/** Before a feed exists there is no project list: loading, never current. */
const NO_PROJECTS: ProjectsState = Object.freeze({
  status: "loading",
  projects: Object.freeze([]),
  current: false,
});

export function navigationFacts({ recovery }: ProjectionSource): NavigationFacts {
  const feed = recovery?.feed ?? null;
  return {
    ready: feed?.ready ?? false,
    stale: feed?.stale ?? false,
    link: feed?.linkState.kind ?? "idle",
    serverId: feed?.serverId ?? null,
    agents: feed?.directory.list() ?? [],
    workspaces: feed?.workspaceList() ?? [],
    truncated: feed?.workspacesTruncated ?? false,
    agentsTruncated: feed?.truncated ?? false,
    projects: feed?.projects ?? NO_PROJECTS,
  };
}

export function inspectorFacts({ connection, recovery }: ProjectionSource): InspectorFacts {
  const feed = recovery?.feed ?? null;
  const state = recovery?.state;
  return {
    connection: connectionState(connection),
    failure:
      (state !== undefined && "error" in state ? state.error : null) ?? feed?.failure ?? null,
    ready: feed?.ready ?? false,
    stale: feed?.stale ?? false,
    link: feed?.linkState.kind ?? "idle",
    serverId: feed?.serverId ?? null,
    workspaces: feed?.workspaceList() ?? [],
    truncated: feed?.workspacesTruncated ?? false,
    projects: feed?.projects ?? NO_PROJECTS,
  };
}

/** Attention (dial 4): the existing feed's agents, no requests of its own. */
export function attentionFacts(source: ProjectionSource): AttentionFacts {
  const inputs = feedInputs(source);
  const feed = source.recovery?.feed ?? null;
  return {
    connection: inputs.connection,
    link: inputs.link,
    stale: inputs.stale,
    failure: inputs.recoveryError ?? inputs.failure,
    ready: inputs.hasSnapshot,
    serverId: inputs.serverId,
    agents: feed?.directory.list() ?? [],
    truncated: feed?.truncated ?? false,
  };
}

/** Usage is asked on the feed's own connection; null without a feed. */
export function usageSource({ recovery }: ProjectionSource): UsageSource | null {
  const feed = recovery?.feed ?? null;
  if (feed === null) return null;
  return {
    owner: feed,
    connectionEpoch: feed.connectionEpoch,
    serverId: feed.serverId,
    connected: feed.linkState.kind === "connected",
    settled: feed.ready && !feed.stale,
    listUsage: () => feed.listUsage(),
  };
}

export function usageFacts({ recovery }: ProjectionSource): { readonly connected: boolean } {
  return { connected: recovery?.feed?.linkState.kind === "connected" };
}

/** The steps of one full redraw, in the order renderAll runs them. */
export interface RenderSteps {
  /**
   * Resolves the Workspace dial contexts (the only sync in a full render)
   * and places agents; every view below reads it.
   */
  readonly syncNavigation: () => void;
  readonly presentSlotKeys: () => void;
  readonly showPagesStrips: () => void;
  readonly refreshWorkspaceDials: () => void;
  /** Starts or abandons usage requests for the current feed generation. */
  readonly syncUsage: () => void;
  readonly refreshUsageDials: () => void;
  readonly refreshAttentionDials: () => void;
}

/**
 * One full redraw after any feed, recovery or dial change. Navigation is
 * synced first, so keys and strips show the placement of the current data;
 * the usage poller follows the feed before the Usage dials are drawn.
 */
export function renderAllSteps(steps: RenderSteps): void {
  steps.syncNavigation();
  steps.presentSlotKeys();
  steps.showPagesStrips();
  steps.refreshWorkspaceDials();
  steps.syncUsage();
  steps.refreshUsageDials();
  steps.refreshAttentionDials();
}
