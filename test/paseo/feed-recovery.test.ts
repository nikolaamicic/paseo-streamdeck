import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AgentFeed,
  AgentFeedError,
  type AgentFeedErrorCode,
  type FeedCloseOutcome,
} from "../../src/paseo/agent-feed.ts";
import {
  FeedRecovery,
  RETRY_DELAY_MS,
  START_TIMEOUT_MS,
  type RecoveryEvent,
  type RecoveryState,
} from "../../src/paseo/feed-recovery.ts";
import { FakeClient, flush, ManualScheduler } from "../support/fake-client.ts";
import { entry, snapshot } from "../support/paseo-payloads.ts";

function control<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

class FakeFeed {
  readonly startControl = control<undefined>();
  closeControl: ReturnType<typeof control<undefined>> | null = null;
  closeError: Error | null = null;
  /** False emulates a start that keeps hanging even after close(). */
  closeSettlesStart = true;
  closed = 0;
  fail: (error: AgentFeedErrorCode) => void = () => undefined;

  start(): Promise<void> {
    return this.startControl.promise;
  }

  /** What close() reports when it settles; a confirmed close by default. */
  closeOutcome: FeedCloseOutcome = { subscriptions: "released", client: "closed" };

  /** Resolved when close() is called (an explicit signal for tests). */
  readonly closeCalled = control<undefined>();

  close(): Promise<FeedCloseOutcome> {
    this.closed += 1;
    this.closeCalled.resolve(undefined);
    // Like AgentFeed: closing rejects a pending start with "closed".
    if (this.closeSettlesStart) this.startControl.reject(new AgentFeedError("closed"));
    // A rejection is not part of AgentFeed's contract; the owner fails closed.
    if (this.closeError !== null) return Promise.reject(this.closeError);
    const outcome = this.closeOutcome;
    return (this.closeControl?.promise ?? Promise.resolve()).then(() => outcome);
  }
}

function setup() {
  const clock = new ManualScheduler();
  const feeds: FakeFeed[] = [];
  const events: RecoveryEvent[] = [];
  let changes = 0;
  const recovery = new FeedRecovery<FakeFeed>({
    createFeed: (onTerminalFailure) => {
      const feed = new FakeFeed();
      feed.fail = onTerminalFailure;
      feeds.push(feed);
      return feed;
    },
    timers: clock,
    onChange: () => {
      changes += 1;
    },
    onEvent: (event) => events.push(event),
  });
  return { clock, feeds, events, recovery, changes: () => changes };
}

const feedAt = (feeds: FakeFeed[], index: number): FakeFeed => {
  const feed = feeds[index];
  assert.ok(feed, `feed ${String(index)} exists`);
  return feed;
};

describe("FeedRecovery", () => {
  it("retries 30 s after a failed start, counted from the end of cleanup", async () => {
    const { clock, feeds, recovery } = setup();
    recovery.start();
    recovery.start();
    assert.equal(feeds.length, 1, "start() runs one attempt");
    assert.equal(recovery.state.kind, "starting");
    feedAt(feeds, 0).startControl.reject(new AgentFeedError("connect_failed"));
    await flush();
    assert.deepEqual(recovery.state, { kind: "waiting", error: "connect_failed" });
    assert.equal(feedAt(feeds, 0).closed, 1);
    assert.equal(recovery.feed, null);
    assert.equal(clock.pendingTimers, 1, "exactly one retry timer");

    clock.advance(RETRY_DELAY_MS - 1);
    assert.equal(feeds.length, 1);
    clock.advance(1);
    assert.equal(feeds.length, 2);
    assert.equal(recovery.state.kind, "starting");
    feedAt(feeds, 1).startControl.resolve(undefined);
    await flush();
    assert.equal(recovery.state.kind, "running");
    assert.equal(recovery.feed, feedAt(feeds, 1));
    assert.equal(clock.pendingTimers, 0);
  });

  it("does not schedule the retry until the failed feed is closed", async () => {
    const { clock, feeds, recovery } = setup();
    recovery.start();
    const first = feedAt(feeds, 0);
    first.closeControl = control<undefined>();
    first.startControl.reject(new AgentFeedError("subscribe_failed"));
    await flush();
    assert.deepEqual(recovery.state, { kind: "failing", error: "subscribe_failed" });
    assert.equal(recovery.retryAvailable, false);
    assert.equal(recovery.retryNow(), false);
    assert.equal(clock.pendingTimers, 0);
    first.closeControl.resolve(undefined);
    await flush();
    assert.equal(recovery.state.kind, "waiting");
    assert.equal(clock.pendingTimers, 1);
  });

  it("times out a hanging start, closes it and ignores its late success", async () => {
    const { clock, feeds, recovery } = setup();
    recovery.start();
    const first = feedAt(feeds, 0);
    first.closeSettlesStart = false;
    await flush();
    clock.advance(START_TIMEOUT_MS - 1);
    await flush();
    assert.equal(recovery.state.kind, "starting");
    clock.advance(1);
    await flush();
    assert.deepEqual(recovery.state, { kind: "waiting", error: "start_timeout" });
    assert.equal(first.closed, 1, "the timed-out feed and its client are released");
    first.startControl.resolve(undefined);
    await flush();
    assert.equal(recovery.state.kind, "waiting", "a late start never marks it running");
    assert.equal(recovery.feed, null);
    assert.equal(clock.pendingTimers, 1, "only the retry timer");
  });

  it("does not retry an authentication failure on its own, but allows Retry", async () => {
    const { clock, feeds, recovery } = setup();
    recovery.start();
    feedAt(feeds, 0).startControl.reject(new AgentFeedError("auth_failed"));
    await flush();
    assert.deepEqual(recovery.state, { kind: "blocked", error: "auth_failed" });
    assert.equal(clock.pendingTimers, 0);
    clock.advance(10 * RETRY_DELAY_MS);
    assert.equal(feeds.length, 1);
    assert.equal(recovery.retryAvailable, true);
    assert.equal(recovery.retryNow(), true);
    assert.equal(feeds.length, 2);
  });

  it("starts one attempt for rapid Retry presses and cancels the scheduled retry", async () => {
    const { clock, feeds, recovery } = setup();
    recovery.start();
    feedAt(feeds, 0).startControl.reject(new AgentFeedError("connect_failed"));
    await flush();
    assert.equal(recovery.retryNow(), true);
    assert.equal(recovery.retryNow(), false);
    assert.equal(recovery.retryNow(), false);
    assert.equal(feeds.length, 2);
    assert.equal(clock.pendingTimers, 1, "only the new attempt's start deadline");
    clock.advance(RETRY_DELAY_MS - 1);
    assert.equal(feeds.length, 2, "the cancelled retry does not fire");
  });

  it("keeps recovering when closing the failed feed fails", async () => {
    const { clock, feeds, events, recovery } = setup();
    recovery.start();
    const first = feedAt(feeds, 0);
    first.closeError = new Error("raw close failure");
    first.startControl.reject(new AgentFeedError("connect_failed"));
    await flush();
    assert.ok(events.some((event) => event.kind === "cleanup_failed"));
    assert.equal(recovery.state.kind, "waiting");
    assert.equal(clock.pendingTimers, 1);
    assert.doesNotMatch(JSON.stringify(events), /raw close failure/);
  });

  it("recovers from a terminal failure of a running feed and ignores stale reports", async () => {
    const { clock, feeds, recovery } = setup();
    recovery.start();
    const first = feedAt(feeds, 0);
    first.startControl.resolve(undefined);
    await flush();
    first.fail("subscription_failed");
    first.fail("subscription_failed");
    await flush();
    assert.deepEqual(recovery.state, { kind: "waiting", error: "subscription_failed" });
    assert.equal(first.closed, 1);
    assert.equal(clock.pendingTimers, 1);

    clock.advance(RETRY_DELAY_MS);
    feedAt(feeds, 1).startControl.resolve(undefined);
    await flush();
    first.fail("subscription_failed");
    await flush();
    assert.equal(recovery.state.kind, "running", "a report from the old feed is ignored");
    assert.equal(feeds.length, 2);
  });

  it("handles a failure reported during start once", async () => {
    const { clock, feeds, recovery } = setup();
    recovery.start();
    const first = feedAt(feeds, 0);
    first.fail("initial_snapshot_invalid");
    first.startControl.reject(new AgentFeedError("initial_snapshot_invalid"));
    await flush();
    assert.deepEqual(recovery.state, { kind: "waiting", error: "initial_snapshot_invalid" });
    assert.equal(first.closed, 1);
    assert.equal(clock.pendingTimers, 1);
  });

  it("stops during an attempt: closes the feed and never changes state again", async () => {
    const { clock, feeds, recovery } = setup();
    recovery.start();
    await recovery.stop();
    assert.equal(recovery.state.kind, "stopped");
    assert.equal(feedAt(feeds, 0).closed, 1);
    await flush();
    assert.equal(recovery.state.kind, "stopped");
    assert.equal(clock.pendingTimers, 0);
    clock.advance(10 * RETRY_DELAY_MS);
    assert.equal(feeds.length, 1);
    assert.equal(recovery.retryNow(), false);
  });

  it("stops while waiting: cancels the retry timer", async () => {
    const { clock, feeds, recovery } = setup();
    recovery.start();
    feedAt(feeds, 0).startControl.reject(new AgentFeedError("connect_failed"));
    await flush();
    await recovery.stop();
    assert.equal(clock.pendingTimers, 0);
    clock.advance(RETRY_DELAY_MS);
    assert.equal(feeds.length, 1);
  });

  it("handles a terminal failure that arrives after start succeeded but before the attempt continued", async () => {
    const { clock, feeds, recovery } = setup();
    recovery.start();
    const first = feedAt(feeds, 0);
    first.startControl.resolve(undefined);
    first.fail("subscription_failed");
    await flush();
    assert.deepEqual(recovery.state, { kind: "waiting", error: "subscription_failed" });
    assert.equal(first.closed, 1, "closed once");
    assert.equal(clock.pendingTimers, 1, "one retry, no leftover start deadline");
  });

  it("does not let a late start success overwrite a failure", async () => {
    const { clock, feeds, recovery } = setup();
    recovery.start();
    const first = feedAt(feeds, 0);
    first.closeSettlesStart = false;
    first.fail("initial_snapshot_invalid");
    await flush();
    assert.equal(recovery.state.kind, "waiting");
    first.startControl.resolve(undefined);
    await flush();
    assert.deepEqual(recovery.state, { kind: "waiting", error: "initial_snapshot_invalid" });
    assert.equal(clock.pendingTimers, 1);
  });

  it("stops a start that keeps hanging after close without leaving a timer", async () => {
    const { clock, feeds, recovery } = setup();
    recovery.start();
    feedAt(feeds, 0).closeSettlesStart = false;
    await recovery.stop();
    assert.equal(clock.pendingTimers, 0);
    assert.equal(feedAt(feeds, 0).closed, 1);
  });

  it("waits in stop() for a cleanup already in progress, also for concurrent calls", async () => {
    const { feeds, recovery } = setup();
    recovery.start();
    const first = feedAt(feeds, 0);
    first.closeControl = control<undefined>();
    first.startControl.reject(new AgentFeedError("connect_failed"));
    await flush();
    assert.equal(recovery.state.kind, "failing");
    let done = 0;
    const one = recovery.stop().then(() => (done += 1));
    const two = recovery.stop().then(() => (done += 1));
    await flush();
    assert.equal(done, 0, "neither stop() resolves while the close is pending");
    first.closeControl.resolve(undefined);
    await Promise.all([one, two]);
    assert.equal(done, 2);
    assert.equal(recovery.state.kind, "stopped");
  });

  it("keeps recovering when observers throw", async () => {
    const clock = new ManualScheduler();
    const feeds: FakeFeed[] = [];
    const events: string[] = [];
    let unhandled = 0;
    const onUnhandled = (): void => {
      unhandled += 1;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const throwingEvents of [false, true]) {
        const recovery = new FeedRecovery<FakeFeed>({
          createFeed: () => {
            const feed = new FakeFeed();
            feeds.push(feed);
            return feed;
          },
          timers: clock,
          onChange: () => {
            throw new Error("observer");
          },
          onEvent: (event) => {
            if (throwingEvents) throw new Error("sink");
            events.push(event.kind);
          },
        });
        recovery.start();
        feedAt(feeds, feeds.length - 1).startControl.reject(new AgentFeedError("connect_failed"));
        await flush();
        assert.equal(recovery.state.kind, "waiting", "not stuck in starting");
        assert.equal(recovery.retryNow(), true);
        assert.equal(recovery.state.kind, "starting");
        await recovery.stop();
      }
      assert.ok(events.includes("observer_failed"));
      assert.equal(unhandled, 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.equal(clock.pendingTimers, 0);
  });

  it("handles the same race with the concrete AgentFeed", async () => {
    const scheduler = new ManualScheduler();
    const clients: FakeClient[] = [];
    const recovery = new FeedRecovery<AgentFeed>({
      createFeed: (onTerminalFailure) => {
        const client = new FakeClient();
        client.initialSnapshot = snapshot([entry({ id: "a" })]);
        clients.push(client);
        const feed = new AgentFeed(
          client,
          {
            onFailure: (error) => {
              onTerminalFailure(error.code);
            },
          },
          { scheduler },
        );
        const start = feed.start.bind(feed);
        // The subscription fails right after start() resolved, before the
        // owner's continuation runs.
        feed.start = async () => {
          await start();
          if (clients.length === 1) client.emitError(new Error("raw failure"));
        };
        return feed;
      },
      timers: scheduler,
    });
    recovery.start();
    await flush();
    assert.deepEqual(recovery.state, { kind: "waiting", error: "subscription_failed" });
    assert.equal(clients[0]?.closed, 1);
    assert.equal(scheduler.pendingTimers, 1);
    scheduler.advance(RETRY_DELAY_MS);
    await flush();
    assert.equal(recovery.state.kind, "running");
    assert.equal(clients.length, 2);
    await recovery.stop();
  });

  it("leaves ordinary disconnects to the SDK reconnect", async () => {
    const scheduler = new ManualScheduler();
    const clients: FakeClient[] = [];
    const recovery = new FeedRecovery<AgentFeed>({
      createFeed: (onTerminalFailure) => {
        const client = new FakeClient();
        client.initialSnapshot = snapshot([entry({ id: "a" })]);
        clients.push(client);
        return new AgentFeed(
          client,
          {
            onFailure: (error) => {
              onTerminalFailure(error.code);
            },
          },
          { scheduler },
        );
      },
      timers: scheduler,
    });
    recovery.start();
    await flush();
    assert.equal(recovery.state.kind, "running");
    const client = clients[0];
    assert.ok(client);
    client.state = { status: "disconnected", reason: "Transport closed" };
    scheduler.tick();
    client.state = { status: "connected" };
    scheduler.tick();
    client.emitSnapshot(snapshot([entry({ id: "a" })]));
    await flush();
    assert.equal(recovery.state.kind, "running");
    assert.equal(clients.length, 1, "no second client");
    assert.equal(recovery.feed?.snapshotsApplied, 2);
    assert.equal(scheduler.pendingTimers, 0);
    await recovery.stop();
    assert.equal(client.closed, 1);
  });
});

/** A recovery owner whose state changes the test can wait for, without flush. */
function setupWithWaiter() {
  const clock = new ManualScheduler();
  const feeds: FakeFeed[] = [];
  const events: RecoveryEvent[] = [];
  const waiters: { kind: string; resolve: () => void }[] = [];
  const recovery: FeedRecovery<FakeFeed> = new FeedRecovery<FakeFeed>({
    createFeed: (onTerminalFailure) => {
      const feed = new FakeFeed();
      feed.fail = onTerminalFailure;
      feeds.push(feed);
      return feed;
    },
    timers: clock,
    onChange: () => {
      for (const waiter of waiters.splice(0)) {
        if (waiter.kind === recovery.state.kind) waiter.resolve();
        else waiters.push(waiter);
      }
    },
    onEvent: (event) => events.push(event),
  });
  return { clock, feeds, events, recovery, waiters };
}

/** Settles once the owner reaches `kind` (or already is there). */
function reached(
  harness: ReturnType<typeof setupWithWaiter>,
  kind: RecoveryState["kind"],
): Promise<void> {
  if (harness.recovery.state.kind === kind) return Promise.resolve();
  const reach = control<undefined>();
  harness.waiters.push({
    kind,
    resolve: () => {
      reach.resolve(undefined);
    },
  });
  return reach.promise.then(() => undefined);
}

describe("FeedRecovery.stop outcome (C3b1)", () => {
  it("no feed was ever created: none", async () => {
    const { recovery } = setupWithWaiter();
    assert.deepEqual(await recovery.stop(), { client: "none" });
  });

  it("a confirmed close of the running feed: closed", async () => {
    const h = setupWithWaiter();
    h.recovery.start();
    feedAt(h.feeds, 0).startControl.resolve(undefined);
    await reached(h, "running");
    assert.deepEqual(await h.recovery.stop(), { client: "closed" });
    assert.equal(
      h.events.some((event) => event.kind === "cleanup_failed"),
      false,
    );
  });

  it("an unconfirmed client close: failed, and cleanup_failed is logged", async () => {
    const h = setupWithWaiter();
    h.recovery.start();
    const feed = feedAt(h.feeds, 0);
    feed.startControl.resolve(undefined);
    await reached(h, "running");
    feed.closeOutcome = { subscriptions: "released", client: "failed" };
    assert.deepEqual(await h.recovery.stop(), { client: "failed" });
    assert.ok(h.events.some((event) => event.kind === "cleanup_failed"));
  });

  it("a failed unsubscribe with a confirmed client: closed, but cleanup_failed is logged", async () => {
    const h = setupWithWaiter();
    h.recovery.start();
    const feed = feedAt(h.feeds, 0);
    feed.startControl.resolve(undefined);
    await reached(h, "running");
    feed.closeOutcome = { subscriptions: "failed", client: "closed" };
    assert.deepEqual(await h.recovery.stop(), { client: "closed" });
    assert.ok(h.events.some((event) => event.kind === "cleanup_failed"));
  });

  it("an unexpected rejection of close fails closed", async () => {
    const h = setupWithWaiter();
    h.recovery.start();
    const feed = feedAt(h.feeds, 0);
    feed.startControl.resolve(undefined);
    await reached(h, "running");
    feed.closeError = new Error("raw close failure");
    assert.deepEqual(await h.recovery.stop(), { client: "failed" });
    assert.doesNotMatch(JSON.stringify(h.events), /raw close failure/);
  });

  it("an earlier feed's unconfirmed close during a retry stays failed after a later good feed", async () => {
    const h = setupWithWaiter();
    h.recovery.start();
    const first = feedAt(h.feeds, 0);
    first.closeOutcome = { subscriptions: "released", client: "failed" };
    first.startControl.reject(new AgentFeedError("connect_failed"));
    await reached(h, "waiting");
    h.clock.advance(RETRY_DELAY_MS);
    const second = feedAt(h.feeds, 1);
    second.startControl.resolve(undefined);
    await reached(h, "running");
    assert.deepEqual(await h.recovery.stop(), { client: "failed" }, "sticky");
    assert.equal(second.closed, 1);
  });

  it("stop waits for an earlier cleanup still pending, and reports it", async () => {
    const h = setupWithWaiter();
    h.recovery.start();
    const first = feedAt(h.feeds, 0);
    const closing = control<undefined>();
    first.closeControl = closing;
    first.closeOutcome = { subscriptions: "released", client: "failed" };
    first.startControl.reject(new AgentFeedError("connect_failed"));
    await first.closeCalled.promise;
    const stopping = h.recovery.stop();
    assert.equal(h.recovery.stop(), stopping, "repeated stops share one promise");
    closing.resolve(undefined);
    assert.deepEqual(await stopping, { client: "failed" }, "the pending close counted");
    assert.equal(h.feeds.length, 1, "nothing restarted");
    assert.equal(h.clock.pendingTimers, 0);
  });
});
