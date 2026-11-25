import type { AgentAddress } from "../agents/agent-model.ts";
import {
  attentionDisplay,
  attentionIndex,
  attentionItems,
  type AttentionDisplay,
  type AttentionFacts,
  type AttentionInk,
} from "../attention/attention-view.ts";
import type { Timers } from "../paseo/deadline.ts";
import { TextScroller } from "./footer-scroll.ts";
import { ERROR_WORDS } from "./key-view.ts";
import { StripRenderer } from "./strip-renderer.ts";
import { AMBER, GREY, RED, SILVER, WHITE } from "./ui-palette.ts";
import { HINT_FONT, laneOverflow, laneStart, stripLine, VALUE_FONT } from "./strip-scroll.ts";

/**
 * Attention dial strips (dial 4, layouts/attention.json). Each visible dial
 * keeps its own agent by identity (host + agent ID); when that agent leaves
 * the list, or the host changes, the dial shows the first. Turning stops at
 * either end. Pressing opens only the agent of the strip Stream Deck last
 * accepted for this dial, and only while it is still the dial's agent: a
 * strip still being sent, a failed send or a list change refuses the press.
 * Scroll frames keep the identity, so they never block a press. Nothing is
 * sent to agents and no attention state is changed.
 */

/**
 * Touch strip payload for layouts/attention.json. A type alias, not an
 * interface, so it is the SDK's FeedbackPayload as is.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see above
export type AttentionFeedback = {
  readonly label: { readonly value: string; readonly color: string };
  readonly counter: string;
  readonly value: { readonly value: string; readonly color: string };
  readonly hint: string;
};

/** Solid hex colors per ink (design §3, §5). */
const INK: Readonly<Record<AttentionInk, string>> = {
  question: AMBER,
  error: RED,
  white: WHITE,
  calm: SILVER,
  muted: GREY,
};

export type AttentionRotate = "moved" | "unchanged";
export type AttentionPress =
  | { readonly kind: "open"; readonly address: AgentAddress }
  | { readonly kind: "refused" }
  | { readonly kind: "none" };

export interface AttentionDialHandle {
  readonly id: string;
  setFeedback(payload: AttentionFeedback): Promise<void>;
}

export interface AttentionDialsOptions {
  readonly timers: Timers;
  readonly facts: () => AttentionFacts;
  readonly log: (code: string) => void;
}

interface AttentionDial {
  /** Identity of the dial's agent; null before the first item. */
  key: string | null;
  readonly renderer: StripRenderer<AttentionFeedback>;
  readonly scroller: TextScroller;
  base: AttentionDisplay | null;
}

/** The payload for a display at the scroll offsets of value and hint. */
export function attentionFrame(
  display: AttentionDisplay,
  offsets: readonly number[],
): AttentionFeedback {
  const [valueOffset = 0, hintOffset = 0] = offsets;
  return {
    label: { value: stripLine(display.label), color: INK[display.labelInk] },
    counter: display.counter,
    value: {
      value: laneStart(stripLine(display.value), valueOffset, VALUE_FONT),
      color: INK[display.valueInk],
    },
    hint: laneStart(stripLine(display.hint), hintOffset, HINT_FONT),
  };
}

/**
 * Scroll lanes. The key carries the agent's identity as well as the text,
 * so showing another agent restarts both lanes from the start pause even
 * when its title and project are the same; a status change of the same
 * agent with the same text keeps the position.
 */
function lanes(display: AttentionDisplay) {
  const value = stripLine(display.value);
  const hint = stripLine(display.hint);
  const identity = JSON.stringify(display.target);
  return [
    { key: `${identity}${value}`, overflow: laneOverflow(value, VALUE_FONT) },
    { key: `${identity}${hint}`, overflow: laneOverflow(hint, HINT_FONT) },
  ];
}

const errorWord = (code: keyof typeof ERROR_WORDS) => ERROR_WORDS[code];

export class AttentionDials {
  private readonly options: AttentionDialsOptions;
  private readonly dials = new Map<string, AttentionDial>();

  constructor(options: AttentionDialsOptions) {
    this.options = options;
  }

  get count(): number {
    return this.dials.size;
  }

  /** A (re)appearing dial starts on the first agent with fresh timers. */
  appear(handle: AttentionDialHandle): void {
    this.disappear(handle.id);
    const renderer = new StripRenderer<AttentionFeedback>(
      (payload) => handle.setFeedback(payload),
      () => {
        this.options.log("attention_feedback_failed");
      },
    );
    let dial: AttentionDial | null = null;
    const scroller = new TextScroller({
      timers: this.options.timers,
      onFrame: (offsets) => {
        const base = dial?.base ?? null;
        if (base !== null) {
          void renderer.show({ text: attentionFrame(base, offsets), preview: base.target });
        }
      },
    });
    dial = { key: null, renderer, scroller, base: null };
    this.dials.set(handle.id, dial);
    this.render(dial);
  }

  disappear(contextId: string): void {
    const dial = this.dials.get(contextId);
    if (dial === undefined) return;
    dial.scroller.dispose();
    dial.renderer.dispose();
    this.dials.delete(contextId);
  }

  /** Next or previous agent; stops at either end. */
  rotate(contextId: string, ticks: number): AttentionRotate {
    const dial = this.dials.get(contextId);
    const items = attentionItems(this.options.facts());
    if (dial === undefined || items.length === 0 || !Number.isInteger(ticks)) return "unchanged";
    const from = attentionIndex(items, dial.key);
    const to = Math.min(Math.max(from + ticks, 0), items.length - 1);
    dial.key = items[to]?.key ?? null;
    this.render(dial);
    return to === from ? "unchanged" : "moved";
  }

  /**
   * The agent a press may open: the one on the strip Stream Deck accepted,
   * if it is still this dial's agent in the current list.
   */
  press(contextId: string): AttentionPress {
    const dial = this.dials.get(contextId);
    if (dial === undefined) return { kind: "none" };
    const facts = this.options.facts();
    const items = attentionItems(facts);
    const display = attentionDisplay(facts, attentionIndex(items, dial.key), errorWord);
    if (display.target === null) return { kind: "none" };
    const shown = dial.renderer.shown;
    const item = items.find((candidate) => candidate.key === display.target);
    if (shown?.preview !== display.target || dial.key !== display.target || item === undefined) {
      this.render(dial);
      return { kind: "refused" };
    }
    return { kind: "open", address: item.record.address };
  }

  /** Redraws every dial from the current feed; unchanged strips are not resent. */
  refresh(): void {
    for (const dial of this.dials.values()) this.render(dial);
  }

  dispose(): void {
    for (const contextId of [...this.dials.keys()]) this.disappear(contextId);
  }

  private render(dial: AttentionDial): void {
    const facts = this.options.facts();
    const items = attentionItems(facts);
    const index = attentionIndex(items, dial.key);
    // A vanished agent or another host: the dial moves to the first for good.
    dial.key = items[index]?.key ?? null;
    const display = attentionDisplay(facts, index, errorWord);
    dial.base = display;
    dial.scroller.show(lanes(display));
    void dial.renderer.show({
      text: attentionFrame(display, dial.scroller.offsets),
      preview: display.target,
    });
  }
}
