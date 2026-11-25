import { graphemes } from "../text/display-text.ts";
import type { Timers } from "../paseo/deadline.ts";

/**
 * UI-1 (the owner, 2026-11-15): a provider · project footer that does not fit
 * scrolls slowly left, pausing at both ends; a short one stays still.
 * @elgato/streamdeck 3.0.4 offers only setImage per key and no documented
 * animation, and SVG animation is not assumed to work on the device, so each
 * step is a redraw with a new offset at a bounded frame rate.
 */
export const FOOTER_SCROLL = {
  /** 5 frames per second per scrolling key: the setImage rate is bounded. */
  frameMs: 200,
  /** 4 px per frame = 20 px per second on the 120 px key. */
  pixelsPerFrame: 4,
  /**
   * Still at the start and at the end of every pass, so both ends can be
   * read; a whole number of frames (8).
   */
  pauseMs: 1600,
} as const;

/** Footer room before the right-edge fade (x 12 to 98 on the 120 px key). */
export const FOOTER_VISIBLE_WIDTH = 86;

/** Emoji, flags and other pictographs, including ZWJ sequences (one grapheme). */
const PICTOGRAPH = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
/** Full-width East Asian scripts and forms. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}＀-￯]/u;

/**
 * Width estimate in em per grapheme for the footer font (Helvetica Neue 13
 * px, 500). Node cannot measure the device's font, so every class is set
 * above desktop reference measurements (AppKit HelveticaNeue-Medium 13 px,
 * 2026-11-16, not the device): emoji 1.31, CJK/kana 1.00, Hangul 0.87,
 * W 0.94, M 0.89, m 0.87, O 0.76, @% 0.90, accented Latin, Cyrillic, Hebrew
 * and Arabic at most 0.65. Overestimating only adds empty space at the end
 * of a pass; underestimating would hide the last characters. This is a
 * heuristic: scripts not measured fall into the generous default and are
 * not guaranteed.
 */
function graphemeEm(grapheme: string): number {
  if (PICTOGRAPH.test(grapheme)) return 1.4;
  if (WIDE.test(grapheme)) return 1.05;
  if (/^[ilj.,:;'|!·]$/u.test(grapheme)) return 0.3;
  if (/^[ frt()[\]-]$/u.test(grapheme)) return 0.38;
  if (/^[MW]$/u.test(grapheme)) return 1;
  if (/^[@%]$/u.test(grapheme)) return 0.95;
  if (/^[mw]$/u.test(grapheme)) return 0.9;
  if (/^[A-Z]$/u.test(grapheme)) return 0.8;
  if (/^[a-z0-9]$/u.test(grapheme)) return 0.58;
  // Other letters (accented Latin, Cyrillic, Greek, Hebrew, Arabic, ...),
  // judged by the first code point of the grapheme.
  if (/^\p{Lu}/u.test(grapheme)) return 0.8;
  if (/^\p{L}/u.test(grapheme)) return 0.7;
  return 0.85;
}

export function estimateTextWidth(text: string, fontSize = 13): number {
  let em = 0;
  for (const segment of graphemes(text)) em += graphemeEm(segment);
  return em * fontSize;
}

/** Pixels the footer must move to show its end; 0 when it fits. */
export function footerOverflow(text: string | null): number {
  if (text === null) return 0;
  return Math.max(0, Math.ceil(estimateTextWidth(text) - FOOTER_VISIBLE_WIDTH));
}

/**
 * Offset after `frames` frames of one endless loop: pause at 0, move by
 * pixelsPerFrame per frame up to the overflow, pause there, jump back to 0.
 */
export function scrollOffset(frames: number, overflow: number): number {
  if (overflow <= 0) return 0;
  const pause = Math.ceil(FOOTER_SCROLL.pauseMs / FOOTER_SCROLL.frameMs);
  const moving = Math.ceil(overflow / FOOTER_SCROLL.pixelsPerFrame);
  const frame = frames % (pause + moving + pause);
  if (frame < pause) return 0;
  return Math.min(overflow, (frame - pause + 1) * FOOTER_SCROLL.pixelsPerFrame);
}

/** One scrolling text on a key or strip: what it shows and how far it overflows. */
export interface ScrollLane {
  /** Identifies the text; a different key restarts this lane from its start. */
  readonly key: string | null;
  /** Pixels to move to show the end; 0 when it fits. */
  readonly overflow: number;
}

export interface TextScrollerOptions {
  readonly timers: Timers;
  /** Called only when an offset changes, never after dispose(). */
  onFrame(offsets: readonly number[]): void;
}

interface LaneState {
  key: string | null;
  overflow: number;
  frames: number;
  offset: number;
}

/**
 * Scroll state of one visible key or dial strip: several texts (lanes,
 * e.g. title and footer) share one frame clock, so there is at most one
 * pending timer and one redraw per frame, and it runs only while a lane
 * overflows. Each lane restarts only when its own text changes, so a status
 * change in one line does not restart another. Positions are counted in
 * frames, not wall time, so a busy event loop slows the scroll instead of
 * skipping text.
 */
export class TextScroller {
  private readonly options: TextScrollerOptions;
  private lanes: LaneState[] = [];
  private timer: { cancel(): void } | null = null;
  private disposed = false;

  constructor(options: TextScrollerOptions) {
    this.options = options;
  }

  get offsets(): readonly number[] {
    return this.lanes.map((lane) => lane.offset);
  }

  /**
   * Follows the current texts, in a fixed lane order. A lane whose key or
   * overflow changed starts from the beginning; the others keep their
   * position.
   */
  show(lanes: readonly ScrollLane[]): void {
    if (this.disposed) return;
    const previous = this.lanes;
    this.lanes = lanes.map((lane, index) => {
      const known = previous[index];
      if (known?.key === lane.key && known.overflow === lane.overflow) return known;
      return { key: lane.key, overflow: lane.overflow, frames: 0, offset: 0 };
    });
    const restarted =
      this.lanes.length !== previous.length ||
      this.lanes.some((lane, index) => lane !== previous[index]);
    // Restart the frame clock when a lane restarted, so its full start pause
    // runs from the new image instead of from a frame already scheduled.
    if (restarted) this.stop();
    if (this.lanes.some((lane) => lane.overflow > 0)) this.schedule();
    else this.stop();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private schedule(): void {
    this.timer ??= this.options.timers.after(FOOTER_SCROLL.frameMs, () => {
      this.timer = null;
      this.tick();
    });
  }

  private tick(): void {
    if (this.disposed) return;
    let changed = false;
    for (const lane of this.lanes) {
      if (lane.overflow <= 0) continue;
      lane.frames += 1;
      const next = scrollOffset(lane.frames, lane.overflow);
      if (next !== lane.offset) {
        lane.offset = next;
        changed = true;
      }
    }
    if (!this.lanes.some((lane) => lane.overflow > 0)) return;
    this.schedule();
    if (changed) this.options.onFrame(this.offsets);
  }

  private stop(): void {
    this.timer?.cancel();
    this.timer = null;
  }
}
