import type { Timers } from "../paseo/deadline.ts";
import type { UsageState } from "../usage/usage-poller.ts";
import {
  usageDisplay,
  usageIndex,
  usageItems,
  type UsageDisplay,
  type UsageFacts,
  type UsageItem,
  type ValueInk,
} from "../usage/usage-view.ts";
import { TextScroller } from "./footer-scroll.ts";
import { StripRenderer } from "./strip-renderer.ts";
import { AMBER, GREY, RED, SILVER, WHITE } from "./ui-palette.ts";
import {
  HINT_FONT,
  laneOverflow,
  laneStart,
  stripLine,
  VALUE_FONT,
  type LaneFont,
} from "./strip-scroll.ts";

/**
 * Usage dial strips (U2; layout
 * layouts/usage.json). Each visible dial keeps its own position, held by
 * the item's stable key across refreshes; when that item is gone it shows
 * the first one. Turning moves through the reported items without wrapping
 * (implementation choice); pressing returns to the first (the owner's
 * decision). Nothing here sends requests; the strips show UsagePoller's
 * state. Long title, value and hint lines scroll like the Workspace strip.
 */

/**
 * Touch strip payload for layouts/usage.json. A type alias, not an
 * interface, so it is the SDK's FeedbackPayload as is.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see above
export type UsageFeedback = {
  readonly label: string;
  readonly counter: string;
  readonly value: { readonly value: string; readonly color: string };
  readonly bar: { readonly value: number; readonly bar_fill_c: string; readonly enabled: boolean };
  readonly hint: string;
};

/** Title item of layouts/usage.json: x 12, 128 wide, 15 px. */
const TITLE_FONT: LaneFont = { size: 15, widen: 1, room: 116 };

/** Value and bar colors per ink (design §3); solid hex only. */
const INK: Readonly<Record<ValueInk, { readonly value: string; readonly bar: string }>> = {
  normal: { value: WHITE, bar: SILVER },
  warning: { value: AMBER, bar: AMBER },
  danger: { value: RED, bar: RED },
  muted: { value: GREY, bar: "#6A6A72" },
};

export type UsageDialResult = "moved" | "unchanged" | "not_current";

/**
 * Redraw period while a Usage dial is visible, so "Resets in …" counts down
 * without new usage requests. Unchanged strips are not resent.
 */
export const USAGE_REDRAW_MS = 60_000;

export interface UsageDialHandle {
  readonly id: string;
  setFeedback(payload: UsageFeedback): Promise<void>;
}

export interface UsageDialsOptions {
  readonly timers: Timers;
  readonly state: () => UsageState;
  readonly facts: () => UsageFacts;
  /** Wall clock for reset countdowns. */
  readonly now: () => number;
  readonly log: (code: string) => void;
}

interface UsageDial {
  readonly handle: UsageDialHandle;
  /** Key of the shown item; null before the first data. */
  key: string | null;
  readonly renderer: StripRenderer<UsageFeedback>;
  readonly scroller: TextScroller;
  base: UsageDisplay | null;
}

function lines(display: UsageDisplay): string[] {
  return [stripLine(display.title), stripLine(display.value), stripLine(display.hint)];
}

/** The payload for a display at the lanes' scroll offsets. */
export function usageFrame(display: UsageDisplay, offsets: readonly number[]): UsageFeedback {
  const [title = "", value = "", hint = ""] = lines(display);
  const [titleOffset = 0, valueOffset = 0, hintOffset = 0] = offsets;
  const ink = INK[display.ink];
  return {
    label: laneStart(title, titleOffset, TITLE_FONT),
    counter: display.counter,
    value: { value: laneStart(value, valueOffset, VALUE_FONT), color: ink.value },
    bar: { value: display.bar ?? 0, bar_fill_c: ink.bar, enabled: display.bar !== null },
    hint: laneStart(hint, hintOffset, HINT_FONT),
  };
}

function lanes(display: UsageDisplay) {
  const [title = "", value = "", hint = ""] = lines(display);
  return [
    { key: title, overflow: laneOverflow(title, TITLE_FONT) },
    { key: value, overflow: laneOverflow(value, VALUE_FONT) },
    { key: hint, overflow: laneOverflow(hint, HINT_FONT) },
  ];
}

export class UsageDials {
  private readonly options: UsageDialsOptions;
  private readonly dials = new Map<string, UsageDial>();
  private redraw: { cancel(): void } | null = null;

  constructor(options: UsageDialsOptions) {
    this.options = options;
  }

  /** Visible Usage dials; the poller runs while this is above 0. */
  get count(): number {
    return this.dials.size;
  }

  /** A (re)appearing dial starts on the first item with fresh timers. */
  appear(handle: UsageDialHandle): void {
    this.disappear(handle.id);
    const renderer = new StripRenderer<UsageFeedback>(
      (payload) => handle.setFeedback(payload),
      () => {
        this.options.log("usage_feedback_failed");
      },
    );
    let dial: UsageDial | null = null;
    const scroller = new TextScroller({
      timers: this.options.timers,
      onFrame: (offsets) => {
        const base = dial?.base ?? null;
        if (base !== null) void renderer.show({ text: usageFrame(base, offsets), preview: null });
      },
    });
    dial = { handle, key: null, renderer, scroller, base: null };
    this.dials.set(handle.id, dial);
    this.render(dial);
    this.scheduleRedraw();
  }

  disappear(contextId: string): void {
    const dial = this.dials.get(contextId);
    if (dial === undefined) return;
    dial.scroller.dispose();
    dial.renderer.dispose();
    this.dials.delete(contextId);
    if (this.dials.size === 0) {
      this.redraw?.cancel();
      this.redraw = null;
    }
  }

  /** Next or previous reported item; stops at either end. */
  rotate(contextId: string, ticks: number): UsageDialResult {
    const dial = this.dials.get(contextId);
    const items = this.items();
    if (dial === undefined || items.length === 0 || !Number.isInteger(ticks)) return "not_current";
    const from = usageIndex(items, dial.key);
    const to = Math.min(Math.max(from + ticks, 0), items.length - 1);
    dial.key = items[to]?.key ?? null;
    this.render(dial);
    return to === from ? "unchanged" : "moved";
  }

  /** Back to the first item. */
  press(contextId: string): UsageDialResult {
    const dial = this.dials.get(contextId);
    const items = this.items();
    if (dial === undefined || items.length === 0) return "not_current";
    const from = usageIndex(items, dial.key);
    dial.key = items[0]?.key ?? null;
    this.render(dial);
    return from === 0 ? "unchanged" : "moved";
  }

  /** Redraws every dial from the current state; unchanged strips are not resent. */
  refresh(): void {
    for (const dial of this.dials.values()) this.render(dial);
  }

  dispose(): void {
    for (const contextId of [...this.dials.keys()]) this.disappear(contextId);
  }

  private scheduleRedraw(): void {
    if (this.redraw !== null || this.dials.size === 0) return;
    this.redraw = this.options.timers.after(USAGE_REDRAW_MS, () => {
      this.redraw = null;
      this.refresh();
      this.scheduleRedraw();
    });
  }

  private items(): UsageItem[] {
    const snapshot = this.options.state().snapshot;
    return snapshot === null ? [] : usageItems(snapshot);
  }

  private render(dial: UsageDial): void {
    const items = this.items();
    const index = usageIndex(items, dial.key);
    // A vanished item moves the dial to the first one for good.
    if (items.length > 0) dial.key = items[index]?.key ?? null;
    const display = usageDisplay(
      this.options.state(),
      this.options.facts(),
      index,
      this.options.now(),
    );
    dial.base = display;
    dial.scroller.show(lanes(display));
    void dial.renderer.show({ text: usageFrame(display, dial.scroller.offsets), preview: null });
  }
}
