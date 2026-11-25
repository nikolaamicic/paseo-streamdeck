import type { LinkState } from "../paseo/link-state.ts";
import type { ProjectsState } from "../paseo/project-sync.ts";
import type { MemberCount } from "../workspaces/project-membership.ts";
import {
  findSelectedProject,
  type ProjectSelection,
  type UnresolvedReason,
} from "../workspaces/project-selection.ts";

/**
 * Text of the Project and Agent pages touch strips, as pure functions of a
 * small read-model. Navigation owns the state and its rules (previews,
 * confirmation, pages, dial ownership, presses) and builds the read-model;
 * nothing here changes state.
 */

/**
 * Touch strip text for layouts/segment.json. A type alias, not an
 * interface, so it is the SDK's FeedbackPayload as is.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see above
export type StripText = {
  /** The label's color tells a preview from the confirmed project. */
  readonly label: { readonly value: string; readonly color: string };
  readonly value: string;
  readonly hint: string;
};

/** A strip to show, and which preview it presents. */
export interface StripView {
  readonly text: StripText;
  /** selectionKey() of the previewed selection a press would confirm; null without one. */
  readonly preview: string | null;
}

/**
 * The Project strip Stream Deck last accepted, as far as a press may rely
 * on it. Null when none was accepted, the last send failed, or a pending
 * update would change its preview: then the user may see either strip.
 */
export interface ShownStrip {
  /** selectionKey() of the preview it showed; null for the confirmed project. */
  readonly preview: string | null;
}

/** The feed facts the strip text reads. */
export interface StripFacts {
  readonly link: LinkState["kind"];
  readonly stale: boolean;
  readonly serverId: string | null;
  /** The host's project list (P1); names come only from it. */
  readonly projects: ProjectsState;
}

export type WorkspaceStripModel =
  | { readonly kind: "conflict" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "preview";
      readonly preview: ProjectSelection;
      readonly facts: StripFacts;
      readonly members: MemberCount;
    }
  | {
      readonly kind: "committed";
      readonly committed: ProjectSelection;
      readonly facts: StripFacts;
      /** Agents the keys show for it; null before the keys were arranged. */
      readonly members: MemberCount | null;
    };

export type PagesStripModel =
  | { readonly kind: "loading" }
  | {
      readonly kind: "pages";
      /** Zero-based. */
      readonly page: number;
      readonly pageCount: number;
      readonly members: MemberCount;
      readonly facts: StripFacts;
    };

const MUTED = "#a6a6ae";
/** Preview label color, so a preview never reads as the confirmed project. */
const PREVIEW = "#f0b44c";

const label = (value: string, color = MUTED) => ({ value, color });

const UNRESOLVED_NAMES: Readonly<Record<UnresolvedReason, string>> = {
  other_host: "Other host",
  not_in_list: "Not in list",
  removed: "Removed",
};

/**
 * The name of a selection. A project is named only from the project list;
 * missing from a current list it is "Removed", from a list that is not
 * current (loading, failed, not kept current) "Unknown project".
 */
function selectionName(selection: ProjectSelection, facts: StripFacts): string {
  if (selection.kind === "all") return "All projects";
  if (selection.kind === "unresolved") return UNRESOLVED_NAMES[selection.reason];
  if (selection.address.serverId !== facts.serverId) return "Other host";
  const record = findSelectedProject(facts.projects.projects, selection);
  if (record !== undefined) return record.name;
  return facts.projects.current ? "Removed" : "Unknown project";
}

/** "Offline" or "Updating…" while the agent data is not current; null when it is. */
function feedStatus(facts: StripFacts): string | null {
  if (facts.link !== "connected") return "Offline";
  return facts.stale ? "Updating…" : null;
}

/**
 * Why the project list cannot be relied on, or null when it is current. A
 * new project cannot be confirmed meanwhile; Retry is in the dial's
 * settings (its Property Inspector) for the states that need it.
 */
function projectsStatus(facts: StripFacts): string | null {
  switch (facts.projects.status) {
    case "ready":
      return null;
    case "loading":
      return "Loading projects…";
    case "refreshing":
      return "Updating projects…";
    case "not_live":
    case "unsynchronized":
      return "Projects not live · Retry in settings";
    case "unavailable":
      return "Projects unavailable · Retry in settings";
  }
}

/** "N agents", or "N+ agents" when more may exist than were observed. */
export function agentCount(members: MemberCount): string {
  const count = `${members.count}${members.lowerBound ? "+" : ""}`;
  return `${count} agent${members.count === 1 && !members.lowerBound ? "" : "s"}`;
}

/** The second line of a confirmed selection. */
function committedDetail(
  model: Extract<WorkspaceStripModel, { readonly kind: "committed" }>,
): string {
  const count = model.members === null ? null : agentCount(model.members);
  switch (model.committed.kind) {
    case "unresolved":
      return "Start in not found · turn to choose";
    case "all":
      return count === null ? "Turn to browse" : `${count} · turn to browse`;
    case "project":
      return count ?? "Turn to browse";
  }
}

export function workspaceStripText(model: WorkspaceStripModel): StripText {
  const title = label("Project");
  switch (model.kind) {
    case "conflict":
      return { label: title, value: "Two dials", hint: "Keep one Project dial" };
    case "loading":
      return { label: title, value: "Loading…", hint: "" };
    case "preview": {
      const status = feedStatus(model.facts) ?? projectsStatus(model.facts);
      // The candidate is kept, but a press is refused until the data is
      // current again, so the strip does not ask for one meanwhile.
      return {
        label: label(status === null ? "Preview: press dial" : "Preview", PREVIEW),
        value: selectionName(model.preview, model.facts),
        hint: status ?? agentCount(model.members),
      };
    }
    case "committed": {
      return {
        label: title,
        value: selectionName(model.committed, model.facts),
        // Offline, updating or a project list that is not current always
        // wins over the details below.
        hint: feedStatus(model.facts) ?? projectsStatus(model.facts) ?? committedDetail(model),
      };
    }
  }
}

export function pagesStripText(model: PagesStripModel): StripText {
  const title = label("Agent pages");
  if (model.kind === "loading") return { label: title, value: "Loading…", hint: "" };
  return {
    label: title,
    value: `Page ${model.page + 1} / ${model.pageCount}`,
    hint: feedStatus(model.facts) ?? `${agentCount(model.members)} · press: refresh`,
  };
}
