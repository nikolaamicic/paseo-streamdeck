import { agentKey } from "../agents/agent-model.ts";
import type { Timers } from "../paseo/deadline.ts";
import { footerOverflow, TextScroller } from "./footer-scroll.ts";
import { footerText, keyImageUrl, titleOverflow, titleScrollText } from "./key-svg.ts";
import { KeyRenderer } from "./key-renderer.ts";
import type { KeyView } from "./key-view.ts";

/** A visible key instance (Stream Deck action context). */
export interface VisibleKey {
  readonly renderer: KeyRenderer;
  readonly scroller: TextScroller;
  /** The last view from the data, before the footer offset is applied. */
  base: KeyView | null;
}

/** What drawing a key needs from its SDK action. */
export interface KeyImageTarget {
  setImage(image: string): Promise<void>;
  setTitle(title: string): Promise<void>;
}

/**
 * A key's renderer and footer scroller, with `extra` fields (e.g. a slot).
 * The returned object is the one the scroller's frames read `base` from, so
 * callers must keep and pass that same object to `presentKey`; a copy would
 * leave the frames reading a stale `base`.
 */
export function createVisibleKey<T extends object>(
  action: KeyImageTarget,
  timers: Timers,
  extra: T,
): VisibleKey & T {
  // The whole face is drawn into the SVG; the native title is cleared so it
  // cannot overlap the drawn text.
  const renderer = new KeyRenderer(async (view, isCurrent) => {
    await action.setImage(keyImageUrl(view.face, view.footerOffset, view.titleOffset));
    if (isCurrent()) await action.setTitle("");
  });
  let key: (VisibleKey & T) | null = null;
  // Title and footer frames share one clock and go through the same
  // serialized renderer; a newer frame replaces one not yet drawn, so frames
  // never pile up and never change what a press opens.
  const scroller = new TextScroller({
    timers,
    onFrame: ([titleOffset = 0, footerOffset = 0]) => {
      const base = key?.base ?? null;
      if (base !== null) void renderer.show({ ...base, titleOffset, footerOffset });
    },
  });
  key = { ...extra, renderer, scroller, base: null };
  return key;
}

/**
 * Shows a data view on a key. Each scrolling line (second title line,
 * footer) restarts only when the agent or that line's text changes, so
 * status updates do not reset the scroll. The returned promise settles when
 * the draw run this call started finished; a view queued behind a draw in
 * flight settles at once (that run draws it). It never rejects; callers that
 * only show a view may ignore it.
 */
export function presentKey(key: VisibleKey, view: KeyView): Promise<void> {
  key.base = view;
  const agent = view.identity === null ? "" : agentKey(view.identity);
  const footer = footerText(view.face);
  const title = titleScrollText(view.face);
  key.scroller.show([
    { key: title === null ? null : `${agent}\n${title}`, overflow: titleOverflow(view.face) },
    { key: footer === null ? null : `${agent}\n${footer}`, overflow: footerOverflow(footer) },
  ]);
  const [titleOffset = 0, footerOffset = 0] = key.scroller.offsets;
  return key.renderer.show({ ...view, titleOffset, footerOffset });
}

export function disposeVisibleKey(key: VisibleKey): void {
  key.scroller.dispose();
  key.renderer.dispose();
}
