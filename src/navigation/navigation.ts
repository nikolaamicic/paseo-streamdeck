import { agentKey, type AgentAddress, type AgentRecord } from "../agents/agent-model.ts";
import type { LinkState } from "../paseo/link-state.ts";
import type { ProjectsState } from "../paseo/project-sync.ts";
import type { MemberCount, MembershipFacts } from "../workspaces/project-membership.ts";
import {
  ALL_PROJECTS,
  agentsInSelection,
  choiceSourceOf,
  countInSelection,
  findSelectedProject,
  sameSelection,
  selectionKey,
  selectionList,
  stepSelection,
  type ProjectSelection,
} from "../workspaces/project-selection.ts";
import type { WorkspaceDialContexts } from "../workspaces/workspace-dial-contexts.ts";
import type { WorkspaceRecord } from "../workspaces/workspace-model.ts";
import { AgentLayout, SLOTS_PER_PAGE } from "./agent-layout.ts";
import {
  pagesStripText,
  workspaceStripText,
  type ShownStrip,
  type StripText,
  type StripView,
} from "./navigation-view.ts";

/**
 * Navigation of one Stream Deck + (W7 flow, projects since P2):
 * turning the Project dial (the action with the
 * `…workspace` UUID) moves a preview over "All projects" and the host's
 * projects; only pressing the dial confirms it, and only then do the keys
 * show the agents of that project across all its workspaces. Until then the
 * keys keep the confirmed project. A new project is confirmed only while
 * the agent data and the project list are both current. The Pages dial
 * pages through the agents, eight per page. Nothing here writes settings:
 * Start in stays the startup default.
 *
 * Ownership (the owner's decision, 2026-11-16): the keys of a device follow a
 * Project dial only while it is the only one visible on that device. With
 * two or more, none controls them: their strips say so, turning and
 * pressing are refused, and the keys keep the last confirmed project. With
 * none, the keys also keep it ("All projects" before any). No dial is
 * picked by position.
 *
 * Priority refresh (the owner's decision, 2026-11-16): the keys are re-sorted
 * by priority (spec §6 rule 1) only on an explicit press — of the Pages
 * dial, of the Project dial on its confirmed project, or by confirming a
 * preview — and then show page 1. Status updates never move an agent.
 * A refresh is arranged only from current data of the connected host.
 */

export interface NavigationFacts {
  readonly ready: boolean;
  readonly stale: boolean;
  readonly link: LinkState["kind"];
  readonly serverId: string | null;
  readonly agents: readonly AgentRecord[];
  readonly workspaces: readonly WorkspaceRecord[];
  /** The workspace list holds only the first page of Paseo's workspaces. */
  readonly truncated: boolean;
  /** The agent list holds only the first page of Paseo's agents. */
  readonly agentsTruncated: boolean;
  /** The host's project list (P1): names, and whether a new choice may be confirmed. */
  readonly projects: ProjectsState;
}

/** What one key slot shows; the caller draws it and checks presses against it. */
export type SlotState =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | {
      readonly kind: "agent";
      readonly address: AgentAddress;
      /** No longer in the shown project: stays in place, dimmed, until a relayout (§6 rule 6). */
      readonly dimmed: boolean;
    };

export type { ShownStrip, StripText, StripView } from "./navigation-view.ts";

export { selectionKey } from "../workspaces/project-selection.ts";

export type DialResult =
  | "moved"
  | "unchanged"
  | "committed"
  | "refreshed"
  | "not_shown"
  | "conflict"
  | "not_current"
  | "removed";

interface DeviceState {
  /** Visible Project dial contexts on this device. */
  readonly dials: Set<string>;
  readonly layout: AgentLayout;
  page: number;
  /** Host and selection the layout was arranged for; null before the first. */
  layoutFor: string | null;
  /** Host the layout was arranged for; another host's layout is never shown. */
  layoutHost: string | null;
  /** The selection the keys show, and how many host agents belong to it. */
  shown: ProjectSelection | null;
  members: MemberCount;
  /** agentKey() of the agents of `shown`; a key outside it is dimmed. */
  memberKeys: ReadonlySet<string>;
  /** The selection the keys showed last; kept while no single dial controls them. */
  lastCommitted: ProjectSelection | null;
}

const NO_MEMBERS: MemberCount = Object.freeze({ count: 0, lowerBound: false });

const CONFLICT = "conflict";

/** The agents and workspaces can be checked against the connected host right now. */
function isCurrent(facts: NavigationFacts): boolean {
  return facts.ready && !facts.stale && facts.link === "connected" && facts.serverId !== null;
}

/** A new project may be previewed or confirmed: the project list is current too. */
function canChoose(facts: NavigationFacts): boolean {
  return isCurrent(facts) && facts.projects.current;
}

function membership(facts: NavigationFacts, serverId: string): MembershipFacts {
  return {
    serverId,
    workspaces: facts.workspaces,
    workspacesTruncated: facts.truncated,
    agentsTruncated: facts.agentsTruncated,
  };
}

function listedProject(facts: NavigationFacts, selection: ProjectSelection): boolean {
  return (
    selection.kind === "project" &&
    selection.address.serverId === facts.serverId &&
    findSelectedProject(facts.projects.projects, selection) !== undefined
  );
}

export class Navigation {
  private readonly contexts: WorkspaceDialContexts;
  private readonly facts: () => NavigationFacts;
  private readonly devices = new Map<string, DeviceState>();
  private readonly dialDevice = new Map<string, string>();
  private readonly previews = new Map<string, ProjectSelection>();

  constructor(contexts: WorkspaceDialContexts, facts: () => NavigationFacts) {
    this.contexts = contexts;
    this.facts = facts;
  }

  /** A key or Pages dial is on this device; its layout is kept from now on. */
  useDevice(deviceId: string): void {
    this.device(deviceId);
  }

  workspaceDialShown(contextId: string, deviceId: string): void {
    this.workspaceDialHidden(contextId);
    this.dialDevice.set(contextId, deviceId);
    this.device(deviceId).dials.add(contextId);
  }

  workspaceDialHidden(contextId: string): void {
    const deviceId = this.dialDevice.get(contextId);
    if (deviceId !== undefined) this.devices.get(deviceId)?.dials.delete(contextId);
    this.dialDevice.delete(contextId);
    this.previews.delete(contextId);
  }

  /** After any feed or dial change: resolves choices, drops stale previews, updates layouts. */
  sync(): void {
    const facts = this.facts();
    this.contexts.sync(choiceSourceOf(facts));
    for (const [contextId, preview] of this.previews) {
      if (!this.previewValid(contextId, preview, facts)) this.previews.delete(contextId);
    }
    for (const device of this.devices.values()) this.syncDevice(device, facts);
  }

  rotateWorkspace(contextId: string, ticks: number): DialResult {
    const device = this.dialOwnerDevice(contextId);
    if (device === CONFLICT) return "conflict";
    const facts = this.facts();
    const committed = this.contexts.choice(contextId)?.selection ?? null;
    if (device === null || committed === null || !canChoose(facts) || facts.serverId === null) {
      return "not_current";
    }
    const list = selectionList(facts.projects.projects, facts.serverId);
    const next = stepSelection(list, this.previews.get(contextId) ?? committed, ticks);
    if (sameSelection(next, committed)) this.previews.delete(contextId);
    else this.previews.set(contextId, next);
    return "moved";
  }

  /**
   * Confirms the preview: the keys switch to it, freshly sorted, on page 1.
   * Without a preview the press refreshes the confirmed project the same
   * way (agent data current is enough: no new project is chosen). `shown` is the strip Stream Deck accepted for this dial
   * (StripRenderer.shown); a press acts only when it matches the current
   * state, never on a preview whose strip is pending or failed, and never
   * refreshes while the strip may still show a preview.
   */
  pressWorkspace(contextId: string, shown: ShownStrip | null): DialResult {
    const device = this.dialOwnerDevice(contextId);
    if (device === CONFLICT) return "conflict";
    const preview = this.previews.get(contextId);
    const expected = preview === undefined ? null : selectionKey(preview);
    if (shown?.preview !== expected) return "not_shown";
    const facts = this.facts();
    const choice = this.contexts.choice(contextId);
    if (device === null || choice === undefined || !isCurrent(facts)) return "not_current";
    if (preview === undefined) {
      this.syncDevice(device, facts);
      return this.refresh(device, facts) ? "refreshed" : "not_current";
    }
    if (!facts.projects.current) return "not_current";
    if (
      preview.kind === "unresolved" ||
      (preview.kind === "project" && !listedProject(facts, preview))
    ) {
      this.previews.delete(contextId);
      return "removed";
    }
    choice.choose(preview);
    this.previews.delete(contextId);
    this.syncDevice(device, facts);
    this.refresh(device, facts);
    return "committed";
  }

  /** Pages never wrap; several ticks add up. */
  rotatePages(deviceId: string, ticks: number): DialResult {
    const device = this.devices.get(deviceId);
    if (device?.layoutFor == null || !Number.isInteger(ticks)) return "not_current";
    const page = Math.min(Math.max(device.page + ticks, 0), device.layout.pageCount - 1);
    if (page === device.page) return "unchanged";
    device.page = page;
    return "moved";
  }

  /**
   * Re-sorts the shown agents from current data and returns to page 1.
   * While the data is not current only the page returns to 1 and the
   * result is "not_current": nothing is sorted from an old snapshot.
   */
  pressPages(deviceId: string): DialResult {
    const device = this.devices.get(deviceId);
    if (device?.layoutFor == null) return "not_current";
    const facts = this.facts();
    if (isCurrent(facts)) this.syncDevice(device, facts);
    if (this.refresh(device, facts)) return "refreshed";
    device.page = 0;
    return "not_current";
  }

  /** What key `slot` (0–7) of a device shows. */
  slot(deviceId: string, slot: number): SlotState {
    const device = this.devices.get(deviceId);
    if (device === undefined || !this.shows(device)) return { kind: "loading" };
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS_PER_PAGE) return { kind: "empty" };
    const address = device.layout.at(device.page * SLOTS_PER_PAGE + slot);
    if (address === null) return { kind: "empty" };
    const present = this.facts().agents.some(
      (agent) => agentKey(agent.address) === agentKey(address),
    );
    const dimmed = present && device.shown !== null && !device.memberKeys.has(agentKey(address));
    return { kind: "agent", address, dimmed };
  }

  workspaceStrip(contextId: string): StripView {
    const preview = this.previews.get(contextId);
    return {
      text: this.workspaceText(contextId, preview),
      preview: preview === undefined ? null : selectionKey(preview),
    };
  }

  /** What the Project strip shows; the text comes from navigation-view.ts. */
  private workspaceText(contextId: string, preview: ProjectSelection | undefined): StripText {
    if (this.dialOwnerDevice(contextId) === CONFLICT)
      return workspaceStripText({ kind: "conflict" });
    const facts = this.facts();
    const committed = this.contexts.choice(contextId)?.selection ?? null;
    if (committed === null) return workspaceStripText({ kind: "loading" });
    if (preview !== undefined) {
      const members =
        facts.serverId === null
          ? NO_MEMBERS
          : countInSelection(facts.agents, preview, membership(facts, facts.serverId));
      return workspaceStripText({ kind: "preview", preview, facts, members });
    }
    const device = this.devices.get(this.dialDevice.get(contextId) ?? "");
    return workspaceStripText({
      kind: "committed",
      committed,
      facts,
      members: device?.layoutFor == null ? null : device.members,
    });
  }

  pagesStrip(deviceId: string): StripText {
    const device = this.devices.get(deviceId);
    if (device === undefined || !this.shows(device)) return pagesStripText({ kind: "loading" });
    return pagesStripText({
      kind: "pages",
      page: device.page,
      pageCount: device.layout.pageCount,
      members: device.members,
      facts: this.facts(),
    });
  }

  /** The device's layout belongs to the connected host and can be shown. */
  private shows(device: DeviceState): boolean {
    const facts = this.facts();
    return facts.ready && device.layoutHost !== null && device.layoutHost === facts.serverId;
  }

  private device(deviceId: string): DeviceState {
    let device = this.devices.get(deviceId);
    if (device === undefined) {
      device = {
        dials: new Set(),
        layout: new AgentLayout(),
        page: 0,
        layoutFor: null,
        layoutHost: null,
        shown: null,
        members: NO_MEMBERS,
        memberKeys: new Set(),
        lastCommitted: null,
      };
      this.devices.set(deviceId, device);
    }
    return device;
  }

  /** The dial's device when that dial alone controls it; CONFLICT with several. */
  private dialOwnerDevice(contextId: string): DeviceState | typeof CONFLICT | null {
    const device = this.devices.get(this.dialDevice.get(contextId) ?? "");
    if (device === undefined) return null;
    return device.dials.size > 1 ? CONFLICT : device;
  }

  /** The selection the device's keys show; null while the controlling dial resolves. */
  private selectionFor(device: DeviceState, facts: NavigationFacts): ProjectSelection | null {
    if (device.dials.size === 1) {
      const [owner] = device.dials;
      return owner === undefined ? null : (this.contexts.choice(owner)?.selection ?? null);
    }
    const last = device.lastCommitted ?? ALL_PROJECTS;
    // A project of another host is never applied to this one.
    return last.kind === "project" && last.address.serverId !== facts.serverId
      ? ALL_PROJECTS
      : last;
  }

  private syncDevice(device: DeviceState, facts: NavigationFacts): void {
    if (device.dials.size > 1) {
      for (const contextId of device.dials) this.previews.delete(contextId);
    }
    if (!facts.ready || facts.serverId === null) return;
    const selection = this.selectionFor(device, facts);
    if (selection === null) return;
    device.lastCommitted = selection;
    const layoutFor = JSON.stringify([facts.serverId, selectionKey(selection)]);
    const hostAgents = facts.agents.filter((agent) => agent.address.serverId === facts.serverId);
    const agents = agentsInSelection(hostAgents, selection, membership(facts, facts.serverId));
    if (layoutFor !== device.layoutFor) {
      // Never arrange from data that is not current (e.g. mid host change).
      if (facts.stale) return;
      // A new selection or a host change: a fresh order on page 1.
      this.arrange(device, agents, layoutFor, facts.serverId);
    } else {
      device.layout.update(agents, hostAgents);
    }
    this.showMembers(device, selection, agents, facts, facts.serverId);
    device.page = Math.min(device.page, device.layout.pageCount - 1);
  }

  /**
   * Explicit refresh: the layout already follows the current selection
   * (syncDevice ran first); re-sorting it drops holes and agents that left
   * the project. Refused unless the data is current for that layout's host.
   */
  private refresh(device: DeviceState, facts: NavigationFacts): boolean {
    const selection = device.shown;
    const host = facts.serverId;
    if (
      !isCurrent(facts) ||
      host === null ||
      selection === null ||
      device.layoutFor === null ||
      device.layoutHost !== host
    ) {
      return false;
    }
    const hostAgents = facts.agents.filter((agent) => agent.address.serverId === host);
    const agents = agentsInSelection(hostAgents, selection, membership(facts, host));
    this.arrange(device, agents, device.layoutFor, host);
    this.showMembers(device, selection, agents, facts, host);
    return true;
  }

  private showMembers(
    device: DeviceState,
    selection: ProjectSelection,
    agents: readonly AgentRecord[],
    facts: NavigationFacts,
    host: string,
  ): void {
    device.shown = selection;
    device.memberKeys = new Set(agents.map((agent) => agentKey(agent.address)));
    device.members = countInSelection(facts.agents, selection, membership(facts, host));
  }

  private arrange(
    device: DeviceState,
    agents: readonly AgentRecord[],
    layoutFor: string,
    host: string,
  ): void {
    device.layout.arrange(agents);
    device.layoutFor = layoutFor;
    device.layoutHost = host;
    device.page = 0;
  }

  private previewValid(
    contextId: string,
    preview: ProjectSelection,
    facts: NavigationFacts,
  ): boolean {
    const committed = this.contexts.choice(contextId)?.selection ?? null;
    if (committed === null || sameSelection(preview, committed)) return false;
    if (preview.kind === "all") return true;
    // Kept while the list is not current (a press is refused meanwhile);
    // dropped once its project is gone from the host's known projects.
    return listedProject(facts, preview);
  }
}
