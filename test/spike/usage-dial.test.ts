import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FOOTER_SCROLL, estimateTextWidth } from "../../src/spike/footer-scroll.ts";
import {
  USAGE_REDRAW_MS,
  UsageDials,
  usageFrame,
  type UsageFeedback,
} from "../../src/spike/usage-dial.ts";
import { parseUsageList, type UsageSnapshot } from "../../src/usage/usage-model.ts";
import type { UsageState } from "../../src/usage/usage-poller.ts";
import { flush, ManualScheduler } from "../support/fake-client.ts";

/** Synthetic values only. */
function snapshot(windows: { id: string; label: string; usedPct?: number }[]): UsageSnapshot {
  const parsed = parseUsageList({
    providers: [{ providerId: "claude", displayName: "Claude", status: "available", windows }],
  });
  assert.ok(parsed);
  return parsed;
}

const THREE = [
  { id: "a", label: "Alpha", usedPct: 10 },
  { id: "b", label: "Beta", usedPct: 20 },
  { id: "c", label: "Gamma", usedPct: 30 },
];

class Dial {
  readonly id: string;
  readonly sent: UsageFeedback[] = [];
  constructor(id: string) {
    this.id = id;
  }
  setFeedback(payload: UsageFeedback): Promise<void> {
    this.sent.push(payload);
    return Promise.resolve();
  }
  /** The payload sent last; fails the test when nothing was sent. */
  last(): UsageFeedback {
    const payload = this.sent.at(-1);
    assert.ok(payload, "a strip was sent");
    return payload;
  }
}

function setup(initial: UsageSnapshot | null = snapshot(THREE)) {
  const clock = new ManualScheduler();
  let state: UsageState = { snapshot: initial, failed: false, pending: false, outdated: false };
  let connected = true;
  const logs: string[] = [];
  const dials = new UsageDials({
    timers: clock,
    state: () => state,
    facts: () => ({ connected }),
    now: () => 0,
    log: (code) => logs.push(code),
  });
  return {
    clock,
    dials,
    logs,
    setState: (next: Partial<UsageState>) => {
      state = { ...state, ...next };
      dials.refresh();
    },
    setConnected: (next: boolean) => {
      connected = next;
      dials.refresh();
    },
  };
}

describe("UsageDials", () => {
  it("sends the layout's items: title, counter, value with ink, bar and hint", async () => {
    const { dials } = setup();
    const dial = new Dial("d1");
    dials.appear(dial);
    await flush();
    assert.deepEqual(dial.last(), {
      label: "Claude · Alpha",
      counter: "1/3",
      value: { value: "10% used", color: "#FFFFFF" },
      bar: { value: 10, bar_fill_c: "#D0D0D6", enabled: true },
      hint: "No reset time",
    });
  });

  it("turns without wrapping, presses back to the first, keeps each dial's own item", async () => {
    const { dials } = setup();
    const left = new Dial("left");
    const right = new Dial("right");
    dials.appear(left);
    dials.appear(right);
    assert.equal(dials.rotate("left", 1), "moved");
    assert.equal(dials.rotate("left", 5), "moved");
    assert.equal(dials.rotate("left", 1), "unchanged", "no wrap past the end");
    assert.equal(dials.rotate("left", -9), "moved");
    assert.equal(dials.rotate("left", -1), "unchanged", "no wrap before the start");
    dials.rotate("left", 2);
    await flush();
    assert.equal(left.last().counter, "3/3");
    assert.equal(right.last().counter, "1/3", "the other dial did not move");
    assert.equal(dials.press("left"), "moved");
    assert.equal(dials.press("left"), "unchanged");
    await flush();
    assert.equal(left.last().label, "Claude · Alpha");
  });

  it("keeps the item by key across refreshes and moves to the first when it vanishes", async () => {
    const { dials, setState } = setup();
    const dial = new Dial("d");
    dials.appear(dial);
    dials.rotate("d", 1);
    setState({ snapshot: snapshot([{ id: "0", label: "Aardvark" }, ...THREE]) });
    await flush();
    assert.equal(dial.last().label, "Claude · Beta", "same item at a new position");
    assert.equal(dial.last().counter, "3/4");
    setState({ snapshot: snapshot(THREE.filter((window) => window.id !== "b")) });
    await flush();
    assert.equal(dial.last().label, "Claude · Alpha");
    setState({ snapshot: snapshot(THREE) });
    await flush();
    assert.equal(dial.last().label, "Claude · Alpha", "it does not jump back later");
  });

  it("refuses turning without data and marks last known data muted", async () => {
    const { dials, setState, setConnected } = setup(null);
    const dial = new Dial("d");
    dials.appear(dial);
    assert.equal(dials.rotate("d", 1), "not_current");
    assert.equal(dials.rotate("d", 0.5), "not_current");
    await flush();
    assert.equal(dial.last().value.value, "Loading…");
    assert.equal(dial.last().bar.enabled, false);
    setState({ snapshot: snapshot(THREE) });
    setConnected(false);
    await flush();
    assert.equal(dial.last().hint, "Offline · last known");
    assert.deepEqual(dial.last().bar, { value: 10, bar_fill_c: "#6A6A72", enabled: true });
    assert.equal(dial.last().value.color, "#A6A6AE");
  });

  it("scrolls a long title to its end and stops its timer when the dial disappears", async () => {
    const long = "A very long scoped usage window name for one model";
    const { clock, dials } = setup(snapshot([{ id: "x", label: long, usedPct: 1 }]));
    const dial = new Dial("d");
    dials.appear(dial);
    await flush();
    const first = dial.last().label;
    assert.ok(first.startsWith("Claude · A very"));
    clock.advance(FOOTER_SCROLL.pauseMs + 200 * FOOTER_SCROLL.frameMs);
    await flush();
    assert.ok(
      dial.sent.some((sent) => sent.label.endsWith("for one model") && sent.label !== first),
    );
    dials.disappear("d");
    assert.equal(dials.count, 0);
    assert.equal(clock.pendingTimers, 0, "no scroll timer left");
  });

  it("fits a two-digit counter in its 48 px item", () => {
    const frame = usageFrame(
      { title: "T", counter: "99/99", value: "1% used", ink: "normal", bar: 1, hint: "" },
      [],
    );
    assert.ok(estimateTextWidth(frame.counter, 12) <= 48 - 4);
  });
});

describe("UsageDials countdown", () => {
  it("redraws every minute while visible, without new data, and stops when hidden", async () => {
    const clock = new ManualScheduler();
    let now = Date.parse("2026-11-16T12:00:00.000Z");
    const data = parseUsageList({
      providers: [
        {
          providerId: "claude",
          displayName: "Claude",
          status: "available",
          windows: [{ id: "5h", label: "5h", usedPct: 5, resetsAt: "2026-11-16T12:03:00.000Z" }],
        },
      ],
    });
    assert.ok(data);
    const dials = new UsageDials({
      timers: clock,
      state: () => ({ snapshot: data, failed: false, pending: false, outdated: false }),
      facts: () => ({ connected: true }),
      now: () => now,
      log: () => undefined,
    });
    const dial = new Dial("d");
    dials.appear(dial);
    await flush();
    assert.equal(dial.last().hint, "Resets in 3m");
    now += USAGE_REDRAW_MS;
    clock.advance(USAGE_REDRAW_MS);
    await flush();
    assert.equal(dial.last().hint, "Resets in 2m", "counted down without a feed update");
    dials.disappear("d");
    assert.equal(clock.pendingTimers, 0, "no redraw timer without a visible dial");
  });
});
