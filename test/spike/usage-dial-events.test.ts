import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UsageDials,
  type UsageDialHandle,
  type UsageFeedback,
} from "../../src/spike/usage-dial.ts";
import { UsageDialEvents, type UsageActivation } from "../../src/spike/usage-dial-events.ts";
import { parseUsageList } from "../../src/usage/usage-model.ts";
import { UsagePoller, type UsageSource, type UsageState } from "../../src/usage/usage-poller.ts";
import { deferred, ManualScheduler } from "../support/fake-client.ts";
import { SERVER_ID } from "../support/fixtures.ts";

/**
 * The real UsageDialEvents (M11b2b3) over the real UsageDials and
 * StripRenderer, with fake dials whose sends wait for the test. The first
 * suite records the poller switch only (a fake UsageActivation); the
 * second runs the real UsagePoller over a fake connection whose usage
 * requests the test answers, as one integration scenario, not the whole
 * polling policy (usage-poller.test.ts). The SDK kind check (isDial) and
 * the handle built from the SDK action stay in plugin.ts's UsageDialAction
 * and are not exercised here.
 */

/** Synthetic values only. */
const USAGE = {
  providers: [
    {
      providerId: "claude",
      displayName: "Claude",
      status: "available",
      windows: [
        { id: "a", label: "Alpha", usedPct: 10 },
        { id: "b", label: "Beta", usedPct: 20 },
      ],
    },
  ],
};
const snapshot = parseUsageList(USAGE);
assert.ok(snapshot);
const WITH_DATA: UsageState = { snapshot, failed: false, pending: false, outdated: false };
const NO_DATA: UsageState = { snapshot: null, failed: false, pending: false, outdated: false };

/** A Usage dial whose sends wait for the test. */
class FakeDial implements UsageDialHandle {
  readonly id: string;
  readonly labels: string[] = [];
  alerts = 0;
  private readonly pending: { done: Promise<void>; resolve: () => void }[] = [];
  constructor(id: string) {
    this.id = id;
  }
  setFeedback(payload: UsageFeedback): Promise<void> {
    this.labels.push(payload.label);
    let resolve: () => void = () => undefined;
    const done = new Promise<void>((accept) => {
      resolve = accept;
    });
    this.pending.push({ done, resolve });
    return done;
  }
  showAlert(): Promise<void> {
    this.alerts += 1;
    return Promise.resolve();
  }
  /**
   * Accepts every waiting send, oldest first, waiting for each same
   * promise. The StripRenderer awaited it first, so its bookkeeping (and a
   * queued strip it then sends) is done when that wait returns.
   */
  async acceptAll(): Promise<void> {
    for (let send = this.pending.shift(); send !== undefined; send = this.pending.shift()) {
      send.resolve();
      await send.done;
    }
  }
  get waiting(): number {
    return this.pending.length;
  }
}

// Never needed to pass: a broken controller can leave a send no test
// accepts, and this turns that endless wait into a failure.
const HANG_LIMIT = { timeout: 10_000 };

describe("UsageDialEvents: the poller switch", HANG_LIMIT, () => {
  function setup(state: UsageState = WITH_DATA) {
    const switches: string[] = [];
    let shuttingDown = false;
    const dials = new UsageDials({
      timers: new ManualScheduler(),
      state: () => state,
      facts: () => ({ connected: true }),
      now: () => 0,
      log: () => undefined,
    });
    // Records each switch with the visible dials at that moment.
    const poller: UsageActivation = {
      setActive: (active) => switches.push(`${String(active)}:${String(dials.count)}`),
    };
    const events = new UsageDialEvents({ dials, poller, shutdownStarted: () => shuttingDown });
    return {
      events,
      dials,
      switches,
      beginShutdown: () => {
        shuttingDown = true;
      },
    };
  }

  it("a dial appears, and is drawn, before the poller is switched on", async () => {
    const { events, switches } = setup();
    const dial = new FakeDial("d");
    events.appeared(dial);
    assert.deepEqual(switches, ["true:1"], "the dial was already registered");
    assert.equal(dial.labels.length, 1, "and its first strip sent");
    await dial.acceptAll();
  });

  it("the poller stays on until the last visible dial disappears", async () => {
    const { events, switches } = setup();
    const first = new FakeDial("first");
    const second = new FakeDial("second");
    events.appeared(first);
    events.appeared(second);
    events.disappeared("first");
    events.disappeared("second");
    assert.deepEqual(switches, ["true:1", "true:2", "true:1", "false:0"]);
    await first.acceptAll();
    await second.acceptAll();
  });

  it("a dial reappearing with the same ID counts once and never switches off", async () => {
    const { events, dials, switches } = setup();
    const old = new FakeDial("d");
    const fresh = new FakeDial("d");
    events.appeared(old);
    events.appeared(fresh);
    assert.deepEqual([dials.count, switches], [1, ["true:1", "true:1"]]);
    await old.acceptAll();
    await fresh.acceptAll();
    assert.equal(old.waiting, 0);
  });

  it("an unknown dial disappearing switches by the dials still visible", () => {
    const { events, switches } = setup();
    events.disappeared("unknown");
    assert.deepEqual(switches, ["false:0"]);
  });

  it("after shutdown began no dial appears and the poller is not switched on", () => {
    const { events, dials, switches, beginShutdown } = setup();
    beginShutdown();
    const dial = new FakeDial("d");
    events.appeared(dial);
    assert.deepEqual([dials.count, switches, dial.labels], [0, [], []]);
  });

  it("turning alerts only when there is nothing to turn through", async () => {
    const { events } = setup();
    const dial = new FakeDial("d");
    events.appeared(dial);
    await dial.acceptAll();
    await events.rotated(dial, 1);
    await dial.acceptAll();
    assert.deepEqual([dial.labels.at(-1), dial.alerts], ["Claude · Beta", 0], "moved");
    await events.rotated(dial, 1);
    assert.deepEqual([dial.waiting, dial.alerts], [0, 0], "unchanged: no alert, nothing new");
    await events.rotated(dial, 0.5);
    assert.equal(dial.alerts, 1, "not_current");
    await events.rotated(new FakeDial("unknown"), 1);
    assert.equal(dial.alerts, 1, "another instance's alert");
  });

  it("without data a turn alerts", async () => {
    const { events } = setup(NO_DATA);
    const dial = new FakeDial("d");
    events.appeared(dial);
    await dial.acceptAll();
    await events.rotated(dial, 1);
    assert.equal(dial.alerts, 1);
  });

  it("a press goes back to the first item and signals nothing", async () => {
    const { events } = setup();
    const dial = new FakeDial("d");
    events.appeared(dial);
    await dial.acceptAll();
    await events.rotated(dial, 1);
    await dial.acceptAll();
    events.pressed("d");
    await dial.acceptAll();
    assert.deepEqual([dial.labels.at(-1), dial.alerts], ["Claude · Alpha", 0]);
    events.pressed("unknown");
    assert.equal(dial.waiting, 0);
  });
});

describe("UsageDialEvents with the real UsagePoller", HANG_LIMIT, () => {
  it("asks for usage once while visible; a press asks nothing; hiding stops it", async () => {
    const answers: ReturnType<typeof deferred<unknown>>[] = [];
    const owner = {};
    const source: UsageSource = {
      owner,
      connectionEpoch: 1,
      serverId: SERVER_ID,
      connected: true,
      settled: true,
      listUsage: () => {
        const answer = deferred<unknown>();
        answers.push(answer);
        return answer.promise;
      },
    };
    const clock = new ManualScheduler();
    /** Resolved by the first change after which no request is awaited. */
    let answered = deferred<undefined>();
    /** Visible dials at each poller change. */
    const seen: number[] = [];
    // As plugin.ts: the poller's changes redraw the Usage dials.
    const poller: UsagePoller = new UsagePoller({
      timers: clock,
      source: () => source,
      onChange: () => {
        seen.push(dials.count);
        dials.refresh();
        if (!poller.state.pending) answered.resolve(undefined);
      },
    });
    const dials: UsageDials = new UsageDials({
      timers: clock,
      state: () => poller.state,
      facts: () => ({ connected: true }),
      now: () => 0,
      log: () => undefined,
    });
    const events = new UsageDialEvents({ dials, poller, shutdownStarted: () => false });

    const dial = new FakeDial("d");
    events.appeared(dial);
    assert.equal(answers.length, 1, "switching on asked once");
    assert.deepEqual(seen, [1], "the request redrew at once, with the dial already there");
    const second = new FakeDial("second");
    events.appeared(second);
    assert.equal(answers.length, 1, "a second visible dial asks nothing more");

    answers[0]?.resolve(USAGE);
    await answered.promise;
    await dial.acceptAll();
    await second.acceptAll();
    assert.equal(dial.labels.at(-1), "Claude · Alpha");

    await events.rotated(dial, 1);
    await dial.acceptAll();
    events.pressed("d");
    await dial.acceptAll();
    assert.deepEqual([dial.labels.at(-1), answers.length], ["Claude · Alpha", 1], "no request");

    events.disappeared("second");
    assert.ok(poller.state.snapshot, "one dial still visible: the data is kept");
    events.disappeared("d");
    assert.equal(poller.state.snapshot, null, "the last one hid: the poller forgot its data");

    answered = deferred<undefined>();
    const back = new FakeDial("d");
    events.appeared(back);
    assert.equal(answers.length, 2, "visible again: a new request");
    answers[1]?.resolve(USAGE);
    await answered.promise;
    await back.acceptAll();
    events.disappeared("d");
    poller.dispose();
    assert.deepEqual([dial.waiting, second.waiting, back.waiting], [0, 0, 0]);
  });
});
