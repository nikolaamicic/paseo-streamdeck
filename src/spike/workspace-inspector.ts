import type { AgentFeedErrorCode } from "../paseo/feed-diagnostics.ts";
import type { LinkState } from "../paseo/link-state.ts";
import type { ProjectsState } from "../paseo/project-sync.ts";
import { isRecord } from "../paseo/unknown-value.ts";
import {
  projectKey,
  type ProjectAddress,
  type ProjectRecord,
} from "../workspaces/project-model.ts";
import {
  choiceSourceOf,
  compareProjects,
  resolveStartIn,
  type ProjectSelection,
} from "../workspaces/project-selection.ts";
import type { StartIn } from "../workspaces/start-in-settings.ts";
import type { WorkspaceRecord } from "../workspaces/workspace-model.ts";
import type { ConnectionState } from "../connection/connection-model.ts";

/**
 * View model of the Project dial's Property Inspector (W6, projects since
 * P2). The plugin computes everything here; the inspector page only renders
 * it as text and sends the user's choice back. Labels come from Paseo and
 * are rendered as text content, never as HTML; only IDs travel back.
 */

/** The facts the inspector depends on, read from the existing feed. */
export interface InspectorFacts {
  /** The connection (C3a3); only "ok" has a feed to read. */
  readonly connection: ConnectionState;
  /** The recovery owner's error while it waits for a retry. */
  readonly failure: AgentFeedErrorCode | null;
  readonly ready: boolean;
  readonly stale: boolean;
  readonly link: LinkState["kind"];
  readonly serverId: string | null;
  /** Only to resolve a version 1 (workspace) Start in to its project. */
  readonly workspaces: readonly WorkspaceRecord[];
  /** Paseo has more workspaces than the first directory page holds. */
  readonly truncated: boolean;
  /** The host's project list (P1): the only source of choices and names. */
  readonly projects: ProjectsState;
}

/*
 * InspectorOption and InspectorView are type aliases with a mutable options
 * array, not interfaces: that makes the view itself a valid SDK JSON payload,
 * so the plugin sends it unchanged and no hand-written copy can drop a field
 * (sendInspectorView; plugin.ts passes streamDeck.ui, which typecheck verifies).
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see above
export type InspectorOption = {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see above
export type InspectorView = {
  /** The action context this view is for; the page ignores other contexts. */
  readonly context: string;
  readonly status: string;
  /** A visible warning that the list is incomplete, if it is. */
  readonly notice: string | null;
  readonly canChoose: boolean;
  /** The project list can be read again with "Retry projects" (feed.retryProjects). */
  readonly canRetry: boolean;
  readonly options: InspectorOption[];
  readonly selected: string;
  /** Result of the last choice, if any. */
  readonly message: string | null;
};

/**
 * The part of the SDK's UI controller (streamDeck.ui) an inspector uses;
 * `P` is the payload sent (the Project view, or a connection message).
 */
export interface InspectorUi<P = InspectorView> {
  /** The action whose inspector is visible, if any. */
  readonly action: { readonly id: string } | undefined;
  sendToPropertyInspector(payload: P): Promise<void>;
}

/**
 * Sends a payload as is to the inspector of `context`. The SDK delivers to
 * whichever inspector is visible, so a payload for any other context, or
 * while no inspector is open, is not sent.
 */
export function sendInspectorView<P>(ui: InspectorUi<P>, context: string, view: P): Promise<void> {
  if (ui.action?.id !== context) return Promise.resolve();
  return ui.sendToPropertyInspector(view);
}

export const ALL_VALUE = "all";
/** The saved Start in when it cannot be shown as a list entry. */
const SAVED_VALUE = "saved";

/** Agent data and the project list are current for the connected host. */
export function canChoose(facts: InspectorFacts): boolean {
  return feedCurrent(facts) && facts.projects.current;
}

function feedCurrent(facts: InspectorFacts): boolean {
  return (
    facts.connection === "ok" &&
    facts.failure === null &&
    facts.ready &&
    !facts.stale &&
    facts.link === "connected" &&
    facts.serverId !== null
  );
}

/** States P1 leaves for an explicit Retry; loading and refreshing recover by themselves. */
export function canRetryProjects(facts: InspectorFacts): boolean {
  const status = facts.projects.status;
  return (
    facts.connection === "ok" &&
    facts.failure === null &&
    facts.ready &&
    (status === "unavailable" || status === "not_live" || status === "unsynchronized")
  );
}

function projectStatusText(facts: InspectorFacts): string {
  switch (facts.projects.status) {
    case "loading":
      return "Loading projects…";
    case "refreshing":
      return "Updating the project list…";
    case "unavailable":
      return "The project list is not available. Use Retry projects.";
    case "not_live":
      return "The project list is not kept current. Use Retry projects.";
    case "unsynchronized":
      return "Paseo sent no project list position; the list is not kept current. Use Retry projects.";
    case "ready":
      return hostProjects(facts).length === 0
        ? "No projects found in Paseo."
        : "Choose the project this dial starts in.";
  }
}

function statusText(facts: InspectorFacts): string {
  if (facts.connection === "loading") return "Loading the Paseo connection…";
  if (facts.connection === "unavailable") {
    return "Plugin settings could not be read. Use Retry on the agent key.";
  }
  if (facts.connection === "invalid") return "The Paseo connection settings are not valid.";
  if (facts.connection === "switch_blocked") {
    return "The previous Paseo connection did not close. Restart the plugin.";
  }
  if (facts.failure !== null) return "Cannot reach Paseo. Use Retry on the agent key.";
  if (!facts.ready) return "Loading projects…";
  if (facts.link !== "connected") return "Offline. Showing the last known projects.";
  if (facts.stale) return "Updating the agent list…";
  return projectStatusText(facts);
}

const LEGACY_NOTICE =
  "Saved by an earlier version as a workspace. Choose a project to save it as a project.";

function hostProjects(facts: InspectorFacts): ProjectRecord[] {
  return facts.projects.projects.filter((project) => project.address.serverId === facts.serverId);
}

/**
 * Project names in a stable order. Two projects of the same name stay
 * distinguishable by a number in that order; the value is always the ID.
 */
function projectOptions(facts: InspectorFacts): InspectorOption[] {
  const sorted = hostProjects(facts).sort(compareProjects);
  const counts = new Map<string, number>();
  for (const project of sorted) counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return sorted.map((project) => {
    const index = (seen.get(project.name) ?? 0) + 1;
    seen.set(project.name, index);
    return {
      value: projectKey(project.address),
      label: (counts.get(project.name) ?? 0) > 1 ? `${project.name} (${index})` : project.name,
      disabled: false,
    };
  });
}

/** What the saved Start in means here; null before the host's data is ready. */
function resolvedStartIn(startIn: StartIn, facts: InspectorFacts): ProjectSelection | null {
  if (!facts.ready || facts.stale || facts.serverId === null) return null;
  return resolveStartIn(startIn, { ...choiceSourceOf(facts), serverId: facts.serverId });
}

function savedLabel(startIn: StartIn, resolved: ProjectSelection | null): string {
  const kind = startIn.kind === "legacy_workspace" ? "Saved workspace" : "Saved project";
  if (resolved === null) return kind;
  if (resolved.kind === "unresolved") {
    if (resolved.reason === "other_host") return `${kind} (on another Paseo host)`;
    // Beyond the first page a missing workspace may still exist in Paseo.
    if (resolved.reason === "not_in_list") return `${kind} (not in the shown list)`;
  }
  return `${kind} (no longer available)`;
}

/**
 * The inspector view for one dial. The saved Start in is always shown as
 * selected: when it is not in the current list it appears as a disabled
 * entry, so nothing else is selected or saved silently. A version 1
 * workspace shows the project it resolves to, with a notice; it is written
 * as a project only when the user chooses one.
 */
export function inspectorView(
  context: string,
  startIn: StartIn,
  facts: InspectorFacts,
  message: string | null = null,
): InspectorView {
  const options: InspectorOption[] = [{ value: ALL_VALUE, label: "All projects", disabled: false }];
  options.push(...projectOptions(facts));
  let selected = ALL_VALUE;
  if (startIn.kind !== "all") {
    const resolved = resolvedStartIn(startIn, facts);
    const key = resolved?.kind === "project" ? projectKey(resolved.address) : null;
    if (key !== null && options.some((option) => option.value === key)) selected = key;
    else {
      options.push({ value: SAVED_VALUE, label: savedLabel(startIn, resolved), disabled: true });
      selected = SAVED_VALUE;
    }
  }
  return {
    context,
    status: statusText(facts),
    notice: startIn.kind === "legacy_workspace" ? LEGACY_NOTICE : null,
    canChoose: canChoose(facts),
    canRetry: canRetryProjects(facts),
    options,
    selected,
    message,
  };
}

export type InspectorRequest =
  | { readonly kind: "refresh" }
  | { readonly kind: "retry_projects" }
  | { readonly kind: "choose"; readonly value: string };

/** Longest value the page can send back (an encoded server + project key). */
const MAX_VALUE_LENGTH = 1100;

/** Reads a message from the inspector page; anything else is null. */
export function parseInspectorRequest(payload: unknown): InspectorRequest | null {
  if (!isRecord(payload)) return null;
  if (payload["type"] === "refresh") return { kind: "refresh" };
  if (payload["type"] === "retry_projects") return { kind: "retry_projects" };
  const value = payload["value"];
  if (
    payload["type"] === "choose" &&
    typeof value === "string" &&
    value.length <= MAX_VALUE_LENGTH
  ) {
    return { kind: "choose", value };
  }
  return null;
}

export type ChoiceResult =
  | { readonly ok: true; readonly startIn: ProjectAddress | null }
  | { readonly ok: false; readonly reason: "not_current" | "unknown_project" };

/**
 * Validates a choice against the connected host and the current project
 * list. A choice made from an outdated list, or for a project that is not
 * listed on this host, is refused and nothing is written.
 */
export function resolveInspectorChoice(value: string, facts: InspectorFacts): ChoiceResult {
  if (!canChoose(facts)) return { ok: false, reason: "not_current" };
  if (value === ALL_VALUE) return { ok: true, startIn: null };
  const match = hostProjects(facts).find((project) => projectKey(project.address) === value);
  return match === undefined
    ? { ok: false, reason: "unknown_project" }
    : { ok: true, startIn: match.address };
}
