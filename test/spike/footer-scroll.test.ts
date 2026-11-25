import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateTextWidth,
  FOOTER_SCROLL,
  FOOTER_VISIBLE_WIDTH,
  TextScroller,
  footerOverflow,
  scrollOffset,
} from "../../src/spike/footer-scroll.ts";
import { KeyRenderer } from "../../src/spike/key-renderer.ts";
import type { KeyView } from "../../src/spike/key-view.ts";
import { deferred, flush, ManualScheduler } from "../support/fake-client.ts";

const PAUSE_FRAMES = FOOTER_SCROLL.pauseMs / FOOTER_SCROLL.frameMs;
const LONG = "claude · a-really-long-project-name-for-testing";

function scroller() {
  const clock = new ManualScheduler();
  const frames: number[] = [];
  const instance = new TextScroller({
    timers: clock,
    onFrame: (offsets) => frames.push(offsets[0] ?? -1),
  });
  return { clock, frames, scroller: instance };
}

describe("footer width and overflow", () => {
  it("keeps a short footer still and scrolls only the part that does not fit", () => {
    assert.equal(footerOverflow(null), 0);
    assert.equal(footerOverflow("claude · app"), 0);
    assert.equal(footerOverflow("Offline"), 0);
    const overflow = footerOverflow(LONG);
    assert.ok(overflow > 0);
    assert.equal(overflow, Math.ceil(estimateTextWidth(LONG) - FOOTER_VISIBLE_WIDTH));
  });

  it("estimates wide letters wider than narrow ones", () => {
    assert.ok(estimateTextWidth("mmmm") > estimateTextWidth("iiii"));
    assert.ok(estimateTextWidth("WWWW") > estimateTextWidth("llll"));
  });

  /**
   * Independent desktop reference widths in px: AppKit NSFont
   * HelveticaNeue-Medium 13, NSString.size(withAttributes:), 2026-11-16,
   * measured twice independently. Not the device font; they bound the
   * heuristic from below. The strings are synthetic and mix scripts on
   * purpose (Latin with diacritics, CJK, Hangul, Kana, emoji, flags), as
   * their glyph widths differ.
   */
  const REFERENCE: readonly [string, number][] = [
    ["codex · 工作空间项目测试", 151.931],
    ["codex · 😀😀😀😀😀😀😀😀", 183.931],
    ["工作空间项目测试", 104],
    ["😀😀😀😀😀😀😀😀", 136],
    ["WWWWWWWW", 98.176],
    ["MMMMMMMM", 92.456],
    ["OOOOOOOO", 79.04],
    ["QGDHNOUC", 76.557],
    ["@@@@%%%%", 93.6],
    ["mmmmmmmm", 90.48],
    ["claude · ćevapčići", 108.16],
    ["ŠĐČĆŽšđčćž", 80.535],
    ["가나다라마바사아", 89.96],
    ["ひらがなカタカナ", 104],
    ["🇷🇸🇷🇸🇷🇸🇷🇸", 68],
    ["👨‍👩‍👧‍👦👨‍👩‍👧‍👦", 34],
    ["Привет мир", 74.334],
    ["שלום עולם", 64.006],
    ["مرحبا بالعالم", 68.978],
    ["claude · paseo-streamdeck-workspace", 234.351],
  ];

  it("never underestimates the reference widths, so the end of each text becomes visible", () => {
    for (const [text, measured] of REFERENCE) {
      assert.ok(estimateTextWidth(text) >= measured, `${text}: estimate below ${String(measured)}`);
      // At the last offset the text's real right edge is before the fade (x 98).
      const end = 12 - footerOverflow(text) + measured;
      assert.ok(end <= 12 + FOOTER_VISIBLE_WIDTH, `${text}: ends at ${end.toFixed(1)}`);
    }
  });

  it("stays reasonably close to the references and keeps short ASCII still", () => {
    // Overestimating is the safe side; the bound only catches gross waste.
    // Joined Arabic letters are narrow, so it is the widest overestimate.
    for (const [text, measured] of REFERENCE) {
      assert.ok(estimateTextWidth(text) <= measured * 1.75, `${text}: far too wide`);
    }
    assert.equal(footerOverflow("claude · app"), 0, "measured 74.2 px fits in 86");
  });
});

describe("scrollOffset", () => {
  it("pauses at the start, moves step by step, pauses at the end and jumps back", () => {
    const overflow = 10;
    for (let frame = 0; frame < PAUSE_FRAMES; frame += 1)
      assert.equal(scrollOffset(frame, overflow), 0);
    assert.equal(scrollOffset(PAUSE_FRAMES, overflow), 4);
    assert.equal(scrollOffset(PAUSE_FRAMES + 1, overflow), 8);
    assert.equal(scrollOffset(PAUSE_FRAMES + 2, overflow), 10, "never past the end");
    const moving = Math.ceil(overflow / FOOTER_SCROLL.pixelsPerFrame);
    const endPause = PAUSE_FRAMES + moving;
    for (let frame = endPause; frame < endPause + PAUSE_FRAMES; frame += 1) {
      assert.equal(scrollOffset(frame, overflow), 10);
    }
    assert.equal(scrollOffset(endPause + PAUSE_FRAMES, overflow), 0, "a new pass starts");
    assert.equal(scrollOffset(123, 0), 0);
  });
});

describe("TextScroller", () => {
  it("never starts a timer for a footer that fits", () => {
    const { clock, frames, scroller: instance } = scroller();
    instance.show([{ key: "agent|claude · app", overflow: 0 }]);
    assert.equal(clock.pendingTimers, 0);
    clock.advance(60_000);
    assert.deepEqual(frames, []);
  });

  it("scrolls a long footer after the start pause, with one timer at a time", () => {
    const { clock, frames, scroller: instance } = scroller();
    instance.show([{ key: "agent|long", overflow: 10 }]);
    assert.equal(clock.pendingTimers, 1);
    clock.advance(FOOTER_SCROLL.pauseMs - FOOTER_SCROLL.frameMs);
    assert.deepEqual(frames, [], "no redraw during the start pause");
    clock.advance(FOOTER_SCROLL.frameMs);
    assert.deepEqual(frames, [4], "the first step comes exactly when the pause ends");
    clock.advance(2 * FOOTER_SCROLL.frameMs);
    assert.deepEqual(frames, [4, 8, 10]);
    clock.advance(FOOTER_SCROLL.pauseMs);
    assert.deepEqual(frames, [4, 8, 10], "still at the end during the end pause");
    clock.advance(FOOTER_SCROLL.frameMs);
    assert.deepEqual(frames, [4, 8, 10, 0], "back to the start after the end pause");
    assert.equal(clock.pendingTimers, 1);
    assert.equal(instance.offsets[0], 0);
  });

  it("keeps its position for an unrelated update and restarts for new text or identity", () => {
    const { clock, frames, scroller: instance } = scroller();
    instance.show([{ key: "agent-a|long", overflow: 10 }]);
    clock.advance(FOOTER_SCROLL.pauseMs);
    assert.equal(instance.offsets[0], 4);
    instance.show([{ key: "agent-a|long", overflow: 10 }]);
    assert.equal(instance.offsets[0], 4, "a status change keeps the scroll position");
    instance.show([{ key: "agent-b|long", overflow: 10 }]);
    assert.equal(instance.offsets[0], 0, "another agent starts from the beginning");
    clock.advance(FOOTER_SCROLL.pauseMs - FOOTER_SCROLL.frameMs);
    assert.deepEqual(frames, [4]);
    assert.equal(clock.pendingTimers, 1, "no second timer after the restart");
  });

  it("gives a restarted footer the full start pause from the new image", () => {
    const { clock, frames, scroller: instance } = scroller();
    instance.show([{ key: "agent-a|long", overflow: 10 }]);
    clock.advance(FOOTER_SCROLL.frameMs - 1);
    instance.show([{ key: "agent-b|long", overflow: 10 }]);
    clock.advance(FOOTER_SCROLL.pauseMs - 1);
    assert.deepEqual(frames, [], "still paused 1 ms before the full pause ends");
    clock.advance(1);
    assert.deepEqual(frames, [4]);
    assert.equal(clock.pendingTimers, 1);
  });

  it("stops when the footer fits again and after dispose", () => {
    const { clock, frames, scroller: instance } = scroller();
    instance.show([{ key: "agent|long", overflow: 10 }]);
    instance.show([{ key: "agent|Offline", overflow: 0 }]);
    assert.equal(clock.pendingTimers, 0);
    assert.equal(instance.offsets[0], 0);
    instance.show([{ key: "agent|long", overflow: 10 }]);
    instance.dispose();
    assert.equal(clock.pendingTimers, 0);
    clock.advance(60_000);
    instance.show([{ key: "agent|long", overflow: 10 }]);
    assert.equal(clock.pendingTimers, 0, "nothing restarts after dispose");
    assert.deepEqual(frames, []);
  });
});

describe("TextScroller lanes", () => {
  it("runs several lanes on one timer and restarts only the lane whose text changed", () => {
    const clock = new ManualScheduler();
    const frames: (readonly number[])[] = [];
    const instance = new TextScroller({
      timers: clock,
      onFrame: (offsets) => frames.push(offsets),
    });
    instance.show([
      { key: "title", overflow: 40 },
      { key: "footer", overflow: 8 },
    ]);
    assert.equal(clock.pendingTimers, 1, "one clock for both lanes");
    clock.advance(FOOTER_SCROLL.pauseMs + FOOTER_SCROLL.frameMs);
    assert.deepEqual(instance.offsets, [8, 8]);
    clock.advance(FOOTER_SCROLL.frameMs);
    assert.deepEqual(instance.offsets, [12, 8], "each lane stops at its own end");

    instance.show([
      { key: "title", overflow: 40 },
      { key: "Offline", overflow: 0 },
    ]);
    assert.deepEqual(instance.offsets, [12, 0], "the title keeps its place");
    assert.equal(clock.pendingTimers, 1);
    instance.dispose();
    assert.equal(clock.pendingTimers, 0);
    assert.ok(frames.length > 0);
  });
});

describe("footer frames through the key renderer", () => {
  const A = { serverId: "srv_TestServer01", agentId: "agent-a" };
  const frame = (footerOffset: number): KeyView => ({
    identity: A,
    retry: false,
    footerOffset,
    titleOffset: 0,
    face: {
      kind: "agent",
      status: "running",
      title: "Title",
      provider: "claude",
      project: "a-really-long-project-name-for-testing",
      subagent: false,
      dimmed: false,
      archived: false,
      connection: "live",
    },
  });

  it("coalesces frames while a draw is in flight and never changes what a press acts on", async () => {
    const drawn: number[] = [];
    const gates: (() => void)[] = [];
    const renderer = new KeyRenderer(async (view) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      drawn.push(view.footerOffset);
    });
    const first = renderer.show(frame(0));
    gates.shift()?.();
    await first;
    assert.deepEqual(renderer.renderedIdentity, A);

    const showing = renderer.show(frame(4));
    void renderer.show(frame(8));
    void renderer.show(frame(12));
    assert.equal(renderer.pressChangePending, false, "a frame is not a new agent");
    gates.shift()?.();
    await flush();
    gates.shift()?.();
    await showing;
    assert.deepEqual(drawn, [0, 4, 12], "frame 8 was replaced before it was drawn");
    assert.deepEqual(renderer.renderedIdentity, A);
    assert.equal(renderer.pressChangePending, false);
  });

  it("stops drawing frames after dispose", async () => {
    const stopped = deferred<undefined>();
    let draws = 0;
    const renderer = new KeyRenderer(async () => {
      draws += 1;
      await stopped.promise;
    });
    void renderer.show(frame(0));
    renderer.dispose();
    void renderer.show(frame(4));
    stopped.resolve(undefined);
    await flush();
    assert.equal(draws, 1);
  });
});
