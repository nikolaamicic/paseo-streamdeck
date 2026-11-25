import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StripView } from "../../src/navigation/navigation.ts";
import { scrollOffset, FOOTER_SCROLL } from "../../src/spike/footer-scroll.ts";
import {
  STRIP_SAFE_WIDTH,
  STRIP_TEXT_LIMIT,
  stripLineWidth,
  stripFrame,
  stripLanes,
  stripLine,
} from "../../src/spike/strip-scroll.ts";

const view = (value: string, hint = "", preview: string | null = "k1"): StripView => ({
  text: { label: { value: "Preview: press dial", color: "#f0b44c" }, value, hint },
  preview,
});

describe("strip scrolling", () => {
  it("keeps short names and hints still", () => {
    assert.deepEqual(
      stripLanes(view("main", "Alpha")).map((lane) => lane.overflow),
      [0, 0],
    );
  });

  it("scrolls a long name by starting it further in, keeping label and preview identity", () => {
    const long = view("feature-branch-with-a-very-long-descriptive-name", "Alpha");
    const [name] = stripLanes(long);
    assert.ok(name !== undefined && name.overflow > 0);
    const moved = stripFrame(long, [name.overflow, 0]);
    assert.ok(long.text.value.endsWith(moved.text.value), "a later start of the same name");
    assert.notEqual(moved.text.value, long.text.value);
    assert.deepEqual(moved.text.label, long.text.label);
    assert.equal(moved.preview, "k1", "frames never change what a press confirms");
    assert.equal(stripFrame(long, [0, 0]).text.value, long.text.value);
  });

  it("cleans control characters and caps very long text", () => {
    assert.equal(stripLine("a\u0007b"), "a b");
    const capped = stripLine("x".repeat(200));
    assert.equal(capped.length, STRIP_TEXT_LIMIT);
    assert.ok(capped.endsWith("…"));
  });

  const graphemes = (text: string) =>
    Array.from(
      new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text),
      (p) => p.segment,
    );

  /** Every frame of one full pass, as the scroller would produce it. */
  function pass(value: string): string[] {
    const shown = view(value);
    const [lane] = stripLanes(shown);
    assert.ok(lane);
    const pause = FOOTER_SCROLL.pauseMs / FOOTER_SCROLL.frameMs;
    const frames = 2 * pause + Math.ceil(lane.overflow / FOOTER_SCROLL.pixelsPerFrame);
    return Array.from(
      { length: frames },
      (_, frame) => stripFrame(shown, [scrollOffset(frame, lane.overflow), 0]).text.value,
    );
  }

  it("reaches the end of the name: the last frame fits and differs from the first", () => {
    for (const value of [
      "WWWWWWWW",
      "feature-branch-with-a-very-long-descriptive-name",
      "工作空间项目测试名称工作空间",
      "release 👍🏽 notes 🇷🇸 and Ωmega WWW iii",
    ]) {
      const frames = pass(value);
      const last = frames.at(-1) ?? "";
      assert.notEqual(last, value, `${value} scrolls`);
      assert.ok(value.endsWith(last), "frames are later starts of the same text");
      assert.ok(stripLineWidth(last, "value") <= STRIP_SAFE_WIDTH, `${value}: the end fits`);
    }
  });

  it("shows every grapheme at some point of the pass", () => {
    for (const value of ["WWWWWWWW", "release 👍🏽 notes 🇷🇸 and Ωmega WWW iii"]) {
      const all = graphemes(value);
      const seen = new Set<number>();
      for (const frame of pass(value)) {
        const parts = graphemes(frame);
        const start = all.length - parts.length;
        let used = 0;
        for (const [index, part] of parts.entries()) {
          used += stripLineWidth(part, "value");
          if (used > STRIP_SAFE_WIDTH) break;
          seen.add(start + index);
        }
      }
      assert.equal(seen.size, all.length, `${value}: nothing is skipped`);
    }
  });

  it("keeps the final W frame within an independent width bound", () => {
    // Desktop reference for W at medium weight: 0.94 em (footer-scroll.ts).
    const last = pass("WWWWWWWW").at(-1) ?? "";
    assert.ok(graphemes(last).length * 0.94 * 22 <= STRIP_SAFE_WIDTH);
  });
});
