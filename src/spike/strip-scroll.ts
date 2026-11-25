import type { StripText, StripView } from "../navigation/navigation.ts";
import { estimateTextWidth } from "./footer-scroll.ts";
import { cleanDisplayText, graphemes } from "../text/display-text.ts";

/**
 * Long names on a dial's touch strip segment (W7). The pinned layout
 * schema (@elgato/schemas 0.6.0) offers only clip, ellipsis or fade for
 * overflowing text and no marquee, so a scrolling line is sent as text that
 * starts further in on every frame, through the dial's StripRenderer. Only
 * the drawn text changes; the strip's preview identity stays the same, so
 * frames never block a confirm.
 */

/** Longest name or hint shown, in graphemes; a longer one ends in "…". */
export const STRIP_TEXT_LIMIT = 64;

/** Text item width in layouts/segment.json (x 12 to 188). */
const STRIP_VISIBLE_WIDTH = 176;

/**
 * Width a shown text may use: the item minus room for the right-edge fade,
 * so the last characters of a scrolled name are readable, not faded.
 */
export const STRIP_SAFE_WIDTH = STRIP_VISIBLE_WIDTH - 12;

/**
 * Font sizes of the scrolling items in layouts/segment.json. The value is
 * bold (600), which the width estimate (calibrated at 500) does not cover,
 * so it is widened; overestimating only leaves space at the end of a pass.
 */
/** Font and room of one scrolling text item. */
export interface LaneFont {
  readonly size: number;
  readonly widen: number;
  /** Width the shown text may use (STRIP_SAFE_WIDTH for full-width items). */
  readonly room: number;
}

export const VALUE_FONT: LaneFont = { size: 22, widen: 1.1, room: STRIP_SAFE_WIDTH };
export const HINT_FONT: LaneFont = { size: 12, widen: 1, room: STRIP_SAFE_WIDTH };

/** Cleaned and capped text, the full string a lane scrolls through. */
export function stripLine(text: string): string {
  const parts = graphemes(cleanDisplayText(text));
  return parts.length <= STRIP_TEXT_LIMIT
    ? parts.join("")
    : `${parts.slice(0, STRIP_TEXT_LIMIT - 1).join("")}…`;
}

function width(text: string, font: LaneFont): number {
  return estimateTextWidth(text, font.size) * font.widen;
}

/**
 * How far a text scrolls: the width of the fewest leading graphemes whose
 * removal leaves a rest that fits the font's room. Text is sent from whole
 * graphemes, so the end point is one of those boundaries; at it,
 * laneStart() skips exactly that many graphemes and the end is shown.
 */
export function laneOverflow(text: string, font: LaneFont): number {
  const widths = graphemes(text).map((part) => width(part, font));
  let rest = widths.reduce((sum, next) => sum + next, 0);
  let skipped = 0;
  for (let index = 0; index < widths.length - 1 && rest > font.room; index += 1) {
    const next = widths[index] ?? 0;
    skipped += next;
    rest -= next;
  }
  return skipped === 0 ? 0 : Math.ceil(skipped);
}

/** Estimated drawn width of a strip line (exported for tests). */
export function stripLineWidth(text: string, lane: "value" | "hint"): number {
  return width(text, lane === "value" ? VALUE_FONT : HINT_FONT);
}

/** The text from the first grapheme not scrolled past at `offset` pixels. */
export function laneStart(text: string, offset: number, font: LaneFont): string {
  const parts = graphemes(text);
  let skipped = 0;
  let index = 0;
  for (; index < parts.length - 1; index += 1) {
    const next = width(parts[index] ?? "", font);
    if (skipped + next > offset) break;
    skipped += next;
  }
  return parts.slice(index).join("");
}

/** The two scrolling lanes of a strip: its name (value) and its hint. */
export function stripLanes(view: StripView): { key: string; overflow: number }[] {
  const value = stripLine(view.text.value);
  const hint = stripLine(view.text.hint);
  return [
    { key: value, overflow: laneOverflow(value, VALUE_FONT) },
    { key: hint, overflow: laneOverflow(hint, HINT_FONT) },
  ];
}

/** The view to send for the lanes' current offsets; identity unchanged. */
export function stripFrame(view: StripView, offsets: readonly number[]): StripView {
  const [valueOffset = 0, hintOffset = 0] = offsets;
  const text: StripText = {
    label: view.text.label,
    value: laneStart(stripLine(view.text.value), valueOffset, VALUE_FONT),
    hint: laneStart(stripLine(view.text.hint), hintOffset, HINT_FONT),
  };
  return { text, preview: view.preview };
}
