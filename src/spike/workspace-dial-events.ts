import type { DialResult, ShownStrip } from "../navigation/navigation.ts";
import type { DialHandle, WorkspaceDials } from "./workspace-dial.ts";

/**
 * The Workspace dial's SDK events (M11b2b4), moved from plugin.ts
 * unchanged: the order of registration, drawing and full redraws, and the
 * alerts. Navigation, WorkspaceDials and the Start in contexts keep all
 * state, guards and the settings-write queue; this only orchestrates the
 * events. The SDK action class only checks the SDK kind (isDial) and
 * translates the handle and payloads. Nothing here imports the Stream Deck
 * SDK.
 */

/** An appearing Workspace dial: its handle and its device. */
export interface WorkspaceDialHandle extends DialHandle {
  readonly deviceId: string;
}

/** The action instance of a turn or press. */
export interface WorkspaceDialInput {
  readonly id: string;
  showAlert(): Promise<void>;
}

/** The Navigation methods the Workspace dial uses. */
export interface WorkspaceNavigation {
  workspaceDialShown(contextId: string, deviceId: string): void;
  workspaceDialHidden(contextId: string): void;
  rotateWorkspace(contextId: string, ticks: number): DialResult;
  pressWorkspace(contextId: string, shown: ShownStrip | null): DialResult;
}

export interface WorkspaceDialEventsDeps {
  readonly navigation: WorkspaceNavigation;
  readonly dials: WorkspaceDials;
  /** After shutdown began no dial appears. */
  readonly shutdownStarted: () => boolean;
  /** A full redraw (plugin.ts renderAll). */
  readonly renderAll: () => void;
  /** Fixed codes only. */
  readonly log: (message: string) => void;
}

export class WorkspaceDialEvents {
  private readonly deps: WorkspaceDialEventsDeps;

  constructor(deps: WorkspaceDialEventsDeps) {
    this.deps = deps;
  }

  /** `settings` are the action's raw settings; WorkspaceDials validates them. */
  appeared(handle: WorkspaceDialHandle, settings: unknown): void {
    if (this.deps.shutdownStarted()) return;
    // Registered with the navigation first: appear() draws the strip at once.
    this.deps.navigation.workspaceDialShown(handle.id, handle.deviceId);
    this.deps.dials.appear(handle, settings);
    this.deps.renderAll();
  }

  disappeared(contextId: string): void {
    this.deps.navigation.workspaceDialHidden(contextId);
    this.deps.dials.disappear(contextId);
    this.deps.renderAll();
  }

  settingsReceived(contextId: string, settings: unknown): void {
    this.deps.dials.settingsReceived(contextId, settings);
    this.deps.renderAll();
  }

  /** Moves the preview only; the keys keep the confirmed workspace. */
  async rotated(input: WorkspaceDialInput, ticks: number): Promise<void> {
    const result = this.deps.navigation.rotateWorkspace(input.id, ticks);
    this.deps.renderAll();
    if (result === "conflict" || result === "not_current") {
      this.deps.log(`workspace dial: rotate_${result}`);
      await input.showAlert();
    }
  }

  /** Confirms the preview, or refreshes the confirmed workspace without one. */
  async pressed(input: WorkspaceDialInput): Promise<void> {
    // Only the preview whose strip Stream Deck accepted can be confirmed.
    const shown = this.deps.dials.shownStrip(input.id);
    const result = this.deps.navigation.pressWorkspace(input.id, shown);
    this.deps.renderAll();
    if (result === "committed" || result === "refreshed") return;
    this.deps.log(`workspace dial: press_${result}`);
    await input.showAlert();
  }

  inspectorShown(contextId: string): Promise<void> {
    return this.deps.dials.inspectorShown(contextId);
  }

  /** A message from the inspector; `payload` is unvalidated JSON. */
  async inspectorMessage(contextId: string, payload: unknown): Promise<void> {
    await this.deps.dials.request(contextId, payload);
    // A new Start in applies at once (W6), so the keys may change too.
    this.deps.renderAll();
  }
}
