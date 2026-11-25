import type { UsageDialHandle, UsageDials } from "./usage-dial.ts";

/**
 * The Usage dial's SDK events (M11b2b3), moved from plugin.ts unchanged:
 * the shutdown guard on appear, and switching the usage poller on while a
 * Usage dial is visible. The existing UsageDials keeps the dials and their
 * strips, and the existing UsagePoller its polling policy; this only
 * orchestrates the events. The SDK action class only checks the SDK kind
 * (isDial) and calls it. Nothing here imports the Stream Deck SDK.
 */

/** The poller's switch (UsagePoller.setActive). */
export interface UsageActivation {
  setActive(active: boolean): void;
}

/** The action instance of a turn. */
export interface UsageRotateInput {
  readonly id: string;
  showAlert(): Promise<void>;
}

export interface UsageDialEventsDeps {
  readonly dials: UsageDials;
  readonly poller: UsageActivation;
  /** After shutdown began no dial appears and the poller is not switched on. */
  readonly shutdownStarted: () => boolean;
}

export class UsageDialEvents {
  private readonly deps: UsageDialEventsDeps;

  constructor(deps: UsageDialEventsDeps) {
    this.deps = deps;
  }

  /** The dial first, then the poller: activating may redraw at once. */
  appeared(handle: UsageDialHandle): void {
    if (this.deps.shutdownStarted()) return;
    this.deps.dials.appear(handle);
    this.deps.poller.setActive(true);
  }

  /** Polling stops with the last visible Usage dial. */
  disappeared(contextId: string): void {
    this.deps.dials.disappear(contextId);
    this.deps.poller.setActive(this.deps.dials.count > 0);
  }

  /** An alert only when there is nothing to turn through. */
  async rotated(input: UsageRotateInput, ticks: number): Promise<void> {
    if (this.deps.dials.rotate(input.id, ticks) === "not_current") await input.showAlert();
  }

  /** Back to the first item; the result is not signalled. */
  pressed(contextId: string): void {
    this.deps.dials.press(contextId);
  }
}
