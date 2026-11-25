import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  USAGE_POLL_INTERVAL_MS,
  USAGE_REQUEST_TIMEOUT_MS,
  UsagePoller,
  type UsageSource,
} from "../../src/usage/usage-poller.ts";
import { deferred, flush, ManualScheduler } from "../support/fake-client.ts";

const HOST = "srv_TestServer01";
const OTHER = "srv_OtherHost02";

/** Synthetic usage payload with one window whose used % tells answers apart. */
function payload(usedPct: number): unknown {
  return {
    fetchedAt: "2026-11-16T12:00:00Z",
    providers: [
      {
        providerId: "claude",
        displayName: "Claude",
        status: "available",
        windows: [{ id: "5h", label: "5 hours", usedPct }],
      },
    ],
  };
}

interface Answer {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** A feed-like connection owner; only the owner object is stable. */
class FakeSource {
  readonly answers: Answer[] = [];
  calls = 0;
  connectionEpoch = 1;
  serverId: string | null = HOST;
  connected = true;
  settled = true;
  listUsage: () => Promise<unknown> = () => {
    this.calls += 1;
    return new Promise<unknown>((resolve, reject) => {
      this.answers.push({ resolve, reject });
    });
  };

  /** A fresh wrapper per call, as plugin.ts builds it. */
  view(): UsageSource {
    return {
      owner: this,
      connectionEpoch: this.connectionEpoch,
      serverId: this.serverId,
      connected: this.connected,
      settled: this.settled,
      listUsage: () => this.listUsage(),
    };
  }

  answer(index: number): Answer {
    const answer = this.answers[index];
    assert.ok(answer, `request ${String(index)} was sent`);
    return answer;
  }

  /** The same feed's link comes back (SDK reconnect). */
  reconnect(): void {
    this.connected = true;
    this.connectionEpoch += 1;
  }
}

function setup() {
  const clock = new ManualScheduler();
  let source: FakeSource | null = new FakeSource();
  let changes = 0;
  const poller = new UsagePoller({
    timers: clock,
    source: () => source?.view() ?? null,
    onChange: () => {
      changes += 1;
    },
  });
  const used = () => {
    const entry = poller.state.snapshot?.entries[0];
    return entry?.kind === "window" ? entry.usedPct : null;
  };
  const current = () => {
    assert.ok(source);
    return source;
  };
  return {
    clock,
    poller,
    used,
    current,
    changes: () => changes,
    setSource: (next: FakeSource | null) => {
      source = next;
    },
  };
}

/** Many ordinary feed changes in a row. */
function syncMany(poller: UsagePoller): void {
  for (let i = 0; i < 20; i += 1) poller.sync();
}

describe("UsagePoller timing", () => {
  it("asks only while a dial is visible, then every interval, one awaited at a time", async () => {
    const { clock, poller, current, used } = setup();
    poller.sync();
    assert.equal(current().calls, 0, "no visible Usage dial: no request");
    poller.setActive(true);
    syncMany(poller);
    clock.advance(USAGE_REQUEST_TIMEOUT_MS - 1);
    assert.equal(current().calls, 1);
    current().answer(0).resolve(payload(40));
    await flush();
    assert.equal(used(), 40);
    syncMany(poller);
    clock.advance(USAGE_POLL_INTERVAL_MS - 1);
    syncMany(poller);
    assert.equal(current().calls, 1, "ordinary syncs do not shorten the interval");
    clock.advance(1);
    assert.equal(current().calls, 2, "exactly at the interval");
  });

  for (const [name, fail] of [
    [
      "a rejected request",
      (source: FakeSource) => {
        source.answer(0).reject(new Error("raw"));
      },
    ],
    [
      "a malformed answer",
      (source: FakeSource) => {
        source.answer(0).resolve({ not: "usage" });
      },
    ],
  ] as const) {
    it(`after ${name}, retries only after the interval, whatever syncs happen`, async () => {
      const { clock, poller, current } = setup();
      poller.setActive(true);
      fail(current());
      await flush();
      assert.equal(poller.state.failed, true);
      syncMany(poller);
      clock.advance(USAGE_POLL_INTERVAL_MS - 1);
      syncMany(poller);
      assert.equal(current().calls, 1, "no retry before the interval");
      clock.advance(1);
      assert.equal(current().calls, 2, "retry exactly at the interval");
    });
  }

  it("after a timeout, ignores the late answer and retries only after the interval", async () => {
    const { clock, poller, current, used } = setup();
    poller.setActive(true);
    clock.advance(USAGE_REQUEST_TIMEOUT_MS);
    await flush();
    assert.equal(poller.state.failed, true);
    current().answer(0).resolve(payload(99));
    await flush();
    assert.equal(used(), null, "the answer after the timeout counts for nothing");
    syncMany(poller);
    clock.advance(USAGE_POLL_INTERVAL_MS - 1);
    syncMany(poller);
    assert.equal(current().calls, 1);
    clock.advance(1);
    assert.equal(current().calls, 2);
    current().answer(1).resolve(payload(20));
    await flush();
    assert.equal(poller.state.failed, false);
    assert.equal(used(), 20);
  });

  it("stops and forgets when the last dial disappears; nothing after dispose", async () => {
    const { clock, poller, current, changes, used } = setup();
    poller.setActive(true);
    current().answer(0).resolve(payload(10));
    await flush();
    poller.setActive(false);
    assert.equal(poller.state.snapshot, null);
    assert.equal(clock.pendingTimers, 0);
    poller.setActive(true);
    assert.equal(current().calls, 2, "visible again: asks at once");
    poller.dispose();
    const before = changes();
    current().answer(1).resolve(payload(50));
    await flush();
    assert.equal(changes(), before);
    assert.equal(used(), null);
    assert.equal(clock.pendingTimers, 0);
  });

  it("treats a synchronous throw like a failed request", async () => {
    const { poller, current } = setup();
    current().listUsage = () => {
      throw new Error("sync");
    };
    poller.setActive(true);
    await flush();
    assert.equal(poller.state.failed, true);
  });
});

describe("UsagePoller generations", () => {
  it("a drop voids the pending request; the reconnect asks again at once", async () => {
    const { poller, current, used } = setup();
    poller.setActive(true);
    current().connected = false;
    poller.sync();
    assert.equal(poller.state.pending, false, "not waiting across a drop");
    current().reconnect();
    poller.sync();
    assert.equal(current().calls, 2, "fresh request on the new connection");
    current().answer(0).resolve(payload(11));
    await flush();
    assert.equal(used(), null, "the old connection's answer is discarded");
    current().answer(1).resolve(payload(12));
    await flush();
    assert.equal(used(), 12);
  });

  it("a reconnect first seen when the answer settles still discards it and asks again", async () => {
    const { poller, current, used } = setup();
    poller.setActive(true);
    current().reconnect();
    current().answer(0).resolve(payload(11));
    await flush();
    assert.equal(used(), null);
    assert.equal(current().calls, 2);
  });

  it("rejects an answer from an earlier feed instance of the same host", async () => {
    const { poller, current, setSource, used } = setup();
    poller.setActive(true);
    const old = current();
    const fresh = new FakeSource();
    setSource(fresh);
    poller.sync();
    assert.equal(fresh.calls, 1);
    old.answer(0).resolve(payload(70));
    await flush();
    assert.equal(used(), null, "same host, old feed: discarded");
    fresh.answer(0).resolve(payload(5));
    await flush();
    assert.equal(used(), 5);
  });

  it("never shows another host's quota and rejects the old answer after A → B → A", async () => {
    const { poller, current, used } = setup();
    poller.setActive(true);
    current().answer(0).resolve(payload(10));
    await flush();
    assert.equal(used(), 10);

    current().serverId = OTHER;
    assert.equal(poller.state.snapshot, null, "the old host's data is hidden at once");
    poller.sync();
    assert.equal(current().calls, 2, "B is asked");
    current().serverId = HOST;
    poller.sync();
    assert.equal(current().calls, 3, "A again: a fresh request");
    current().answer(1).resolve(payload(80));
    await flush();
    assert.equal(used(), 10, "B's answer is not A's quota");
    current().answer(2).resolve(payload(30));
    await flush();
    assert.equal(used(), 30);
  });

  it("without a feed nothing is asked; the first feed is asked at once", () => {
    const { poller, setSource } = setup();
    setSource(null);
    poller.setActive(true);
    const fresh = new FakeSource();
    const gate = deferred<unknown>();
    fresh.listUsage = () => {
      fresh.calls += 1;
      return gate.promise;
    };
    setSource(fresh);
    poller.sync();
    assert.equal(fresh.calls, 1);
  });
});

describe("UsagePoller while the feed resyncs", () => {
  it("asks nothing until the host is confirmed, and abandons the request on a resync", async () => {
    const { poller, current } = setup();
    current().settled = false;
    poller.setActive(true);
    assert.equal(current().calls, 0, "host not confirmed: no request");
    current().settled = true;
    poller.sync();
    assert.equal(current().calls, 1);
    current().settled = false;
    poller.sync();
    assert.equal(poller.state.pending, false, "a resync voids the request");
    current().answer(0).resolve(payload(40));
    await flush();
    assert.equal(poller.state.snapshot, null);
  });

  it("marks data of an earlier connection outdated until a new answer, not on schedule", async () => {
    const { clock, poller, current } = setup();
    poller.setActive(true);
    current().answer(0).resolve(payload(10));
    await flush();
    assert.equal(poller.state.outdated, false);
    clock.advance(USAGE_POLL_INTERVAL_MS);
    assert.equal(current().calls, 2);
    assert.equal(poller.state.outdated, false, "a scheduled request keeps data current");
    current().answer(1).resolve(payload(11));
    await flush();

    current().reconnect();
    poller.sync();
    assert.equal(poller.state.outdated, true, "new connection: last known until answered");
    current().answer(2).resolve(payload(12));
    await flush();
    assert.equal(poller.state.outdated, false);
  });
});
