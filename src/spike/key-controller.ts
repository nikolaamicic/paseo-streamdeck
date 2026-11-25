import type { AgentAddress } from "../agents/agent-model.ts";
import type { SlotState } from "../navigation/navigation.ts";
import type { OpenOutcome } from "../opener/open-agent.ts";
import type { Timers } from "../paseo/deadline.ts";
import { handleKeyPress, slotFromCoordinates, slotPressTarget } from "./key-press.ts";
import type { KeyView } from "./key-view.ts";
import {
  createVisibleKey,
  disposeVisibleKey,
  presentKey,
  type KeyImageTarget,
  type VisibleKey,
} from "./visible-key.ts";

/**
 * The plugin's agent keys (M11b2a): the keys placed by the navigation. The
 * separate E1 key with one configured agent was removed at the user's
 * request (the owner, 2026-11-25).
 * Each controller owns its own keys; the SDK action classes only check the
 * SDK kind (isKey, isInMultiAction) and call it. Nothing here imports the
 * Stream Deck SDK.
 */

/** What the controller needs from a key action instance. */
export interface KeyHandle extends KeyImageTarget {
  readonly id: string;
  showAlert(): Promise<void>;
  showOk(): Promise<void>;
}

/** A workspace key also has its device and grid position. */
export interface SlotKeyHandle extends KeyHandle {
  readonly deviceId: string;
  readonly coordinates: { readonly column: number; readonly row: number } | undefined;
}

export interface KeyControllerDeps {
  readonly timers: Timers;
  /** After shutdown began no key appears. */
  readonly shutdownStarted: () => boolean;
  /** What the navigation places on a workspace key's slot. */
  readonly slotState: (deviceId: string, slot: number) => SlotState;
  /** The view of a workspace key's slot. */
  readonly slotView: (deviceId: string, slot: number) => KeyView;
  /** A key or Pages dial is on this device (Navigation.useDevice). */
  readonly useDevice: (deviceId: string) => void;
  /** A full redraw (plugin.ts renderAll). */
  readonly renderAll: () => void;
  readonly isPresent: (address: AgentAddress) => boolean;
  readonly retryNow: () => boolean;
  readonly open: (address: AgentAddress) => Promise<OpenOutcome>;
  /** Fixed codes only. */
  readonly log: (message: string) => void;
}

interface SlotKey extends VisibleKey {
  readonly deviceId: string;
  /** 0–7, or -1 outside the Stream Deck + key grid (shows nothing). */
  readonly slot: number;
}

export class KeyController {
  private readonly deps: KeyControllerDeps;
  private readonly slotKeys = new Map<string, SlotKey>();

  constructor(deps: KeyControllerDeps) {
    this.deps = deps;
  }

  slotAppeared(handle: SlotKeyHandle): void {
    if (this.deps.shutdownStarted()) return;
    const slot = slotFromCoordinates(handle.coordinates);
    // One object: the scroller's frames read `base` from the key it returns.
    const key: SlotKey = createVisibleKey(handle, this.deps.timers, {
      deviceId: handle.deviceId,
      slot,
    });
    const previous = this.slotKeys.get(handle.id);
    if (previous !== undefined) disposeVisibleKey(previous);
    this.slotKeys.set(handle.id, key);
    this.deps.useDevice(key.deviceId);
    this.deps.renderAll();
  }

  slotDisappeared(contextId: string): void {
    const key = this.slotKeys.get(contextId);
    if (key !== undefined) disposeVisibleKey(key);
    this.slotKeys.delete(contextId);
  }

  slotPressed(handle: KeyHandle): Promise<void> {
    const key = this.slotKeys.get(handle.id);
    const state = key === undefined ? null : this.deps.slotState(key.deviceId, key.slot);
    return this.press(handle, key, slotPressTarget(state));
  }

  /** Redraw step: every workspace key shows its slot (settles as presentKey). */
  async presentSlotKeys(): Promise<void> {
    await Promise.all(
      [...this.slotKeys.values()].map((key) =>
        presentKey(key, this.deps.slotView(key.deviceId, key.slot)),
      ),
    );
  }

  /** Shutdown: every key stops drawing and scrolling and is forgotten. */
  dispose(): void {
    for (const key of this.slotKeys.values()) disposeVisibleKey(key);
    this.slotKeys.clear();
  }

  private press(
    handle: KeyHandle,
    key: VisibleKey | undefined,
    expected: AgentAddress | null,
  ): Promise<void> {
    return handleKeyPress({
      renderer: key?.renderer,
      expected,
      isPresent: this.deps.isPresent,
      retryNow: this.deps.retryNow,
      open: this.deps.open,
      showAlert: () => handle.showAlert(),
      showOk: () => handle.showOk(),
      log: this.deps.log,
    });
  }
}
