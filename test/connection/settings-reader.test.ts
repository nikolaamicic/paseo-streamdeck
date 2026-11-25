import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  GlobalSettingsReader,
  SETTINGS_READ_TIMEOUT_MS,
} from "../../src/connection/settings-reader.ts";
import { ManualScheduler } from "../support/fake-client.ts";

/**
 * The global settings reader (C3a2) with a fake SDK whose reads the test
 * settles, and a manual clock. No real SDK, no Stream Deck. Nothing here
 * chooses or changes a connection.
 */

/** A read request the test settles. */
interface Request {
  readonly resolve: (settings: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly done: Promise<unknown>;
  settled: boolean;
}

/**
 * The fake SDK: getGlobalSettings and onDidReceiveGlobalSettings. `calls`
 * records subscribe and get in order; the first `throwingGets` reads throw
 * synchronously.
 */
function fakeSdk(options: { throwingGets?: number } = {}) {
  const requests: Request[] = [];
  const calls: string[] = [];
  let throwsLeft = options.throwingGets ?? 0;
  let listener: ((settings: unknown) => void) | null = null;
  /** The listener as handed over, kept after unsubscribing. */
  let given: ((settings: unknown) => void) | null = null;
  let unsubscribed = 0;
  return {
    requests,
    calls,
    get unsubscribed() {
      return unsubscribed;
    },
    get subscribed() {
      return listener !== null;
    },
    getGlobalSettings: (): Promise<unknown> => {
      calls.push("get");
      if (throwsLeft > 0) {
        throwsLeft -= 1;
        throw new Error("sync");
      }
      let resolve: (settings: unknown) => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      const done = new Promise<unknown>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      const request: Request = {
        resolve: (settings) => {
          request.settled = true;
          resolve(settings);
        },
        reject: (error) => {
          request.settled = true;
          reject(error);
        },
        done,
        settled: false,
      };
      requests.push(request);
      return done;
    },
    subscribe: (next: (settings: unknown) => void) => {
      calls.push("subscribe");
      listener = next;
      given = next;
      return {
        dispose: () => {
          unsubscribed += 1;
          listener = null;
        },
      };
    },
    /** An outside change: the subscription listener, synchronously. */
    emitOutside: (settings: unknown) => {
      listener?.(settings);
    },
    /** An emit already under way when the subscription was disposed. */
    emitThroughStaleListener: (settings: unknown) => {
      given?.(settings);
    },
  };
}

/** Every harness of the current test, cleaned and checked after it. */
const harnesses: {
  reader: GlobalSettingsReader;
  sdk: ReturnType<typeof fakeSdk>;
  clock: ManualScheduler;
}[] = [];

afterEach(async () => {
  for (const { reader, sdk, clock } of harnesses.splice(0)) {
    reader.dispose();
    // An SDK read cannot be aborted; answer what is left, after dispose.
    for (const request of sdk.requests.filter((candidate) => !candidate.settled)) {
      request.resolve({ late: true });
      await request.done;
    }
    assert.equal(sdk.subscribed, false, "no subscription left");
    assert.equal(clock.pendingTimers, 0, "no timer left");
  }
});

function setup(options: { throwingGets?: number } = {}) {
  const sdk = fakeSdk(options);
  const clock = new ManualScheduler();
  let changes = 0;
  const reader = new GlobalSettingsReader({
    getGlobalSettings: () => sdk.getGlobalSettings(),
    subscribe: (listener) => sdk.subscribe(listener),
    timers: clock,
    onChange: () => {
      changes += 1;
    },
  });
  harnesses.push({ reader, sdk, clock });
  return { sdk, clock, reader, changes: () => changes };
}

/** Settles a request and waits until the reader has handled it. */
async function answer(request: Request | undefined, settings: unknown): Promise<void> {
  assert.ok(request, "a read was sent");
  request.resolve(settings);
  await request.done;
}

async function refuse(request: Request | undefined): Promise<void> {
  assert.ok(request, "a read was sent");
  request.reject(new Error("rejected"));
  await request.done.catch(() => undefined);
}

describe("GlobalSettingsReader", () => {
  it("creating it reads nothing, subscribes to nothing and starts no timer", () => {
    const { sdk, clock, changes } = setup();
    assert.deepEqual(
      [sdk.requests.length, sdk.subscribed, clock.pendingTimers, changes()],
      [0, false, 0, 0],
    );
  });

  it("start subscribes, then reads once; a plain object is loaded", async () => {
    const { sdk, clock, reader } = setup();
    reader.start();
    assert.deepEqual(sdk.calls, ["subscribe", "get"], "subscribed before the read is sent");
    reader.start();
    assert.deepEqual(sdk.calls, ["subscribe", "get"], "a second start does nothing");
    assert.deepEqual(reader.state, { known: { kind: "none" }, read: "pending", revision: 0 });
    await answer(sdk.requests[0], { connection: null, other: 1 });
    assert.deepEqual(reader.state, {
      known: { kind: "loaded", settings: { connection: null, other: 1 } },
      read: "idle",
      revision: 1,
    });
    assert.equal(clock.pendingTimers, 0, "the deadline was cancelled");
  });

  it("a read that does not answer in time is timed out, and nothing is known", async () => {
    const { sdk, clock, reader } = setup();
    reader.start();
    clock.advance(SETTINGS_READ_TIMEOUT_MS - 1);
    assert.equal(reader.state.read, "pending");
    clock.advance(1);
    assert.deepEqual(reader.state, { known: { kind: "none" }, read: "timed_out", revision: 0 });
    assert.equal(sdk.requests.length, 1);
    assert.equal(clock.pendingTimers, 0);
    // The SDK read is still in flight; after dispose its answer changes nothing.
    reader.dispose();
    await answer(sdk.requests[0], { a: 1 });
    assert.deepEqual(reader.state.known, { kind: "none" });
  });

  it("a fresh answer after the timeout still applies", async () => {
    const { sdk, clock, reader } = setup();
    reader.start();
    clock.advance(SETTINGS_READ_TIMEOUT_MS);
    await answer(sdk.requests[0], { a: 1 });
    assert.deepEqual(reader.state.known, { kind: "loaded", settings: { a: 1 } });
    assert.equal(reader.state.read, "idle");
  });

  it("a rejected read fails without inventing settings; Retry reads again", async () => {
    const { sdk, clock, reader } = setup();
    reader.start();
    await refuse(sdk.requests[0]);
    assert.deepEqual(reader.state, { known: { kind: "none" }, read: "failed", revision: 0 });
    assert.equal(clock.pendingTimers, 0);
    reader.retry();
    assert.equal(sdk.requests.length, 2, "the failed read was finished, so a new one");
    await answer(sdk.requests[1], { a: 1 });
    assert.deepEqual(reader.state, {
      known: { kind: "loaded", settings: { a: 1 } },
      read: "idle",
      revision: 1,
    });
    assert.equal(clock.pendingTimers, 0);
  });

  it("a read that throws fails without inventing settings; Retry reads again", async () => {
    const { sdk, clock, reader } = setup({ throwingGets: 1 });
    reader.start();
    assert.deepEqual(reader.state, { known: { kind: "none" }, read: "failed", revision: 0 });
    assert.equal(clock.pendingTimers, 0, "no deadline for a read that never started");
    reader.retry();
    assert.deepEqual(sdk.calls, ["subscribe", "get", "get"]);
    await answer(sdk.requests[0], { a: 1 });
    assert.deepEqual(reader.state.known, { kind: "loaded", settings: { a: 1 } });
    assert.equal(clock.pendingTimers, 0);
  });

  it("Retry while a read is in flight sends no second read and only moves the deadline", async () => {
    const { sdk, clock, reader } = setup();
    reader.start();
    clock.advance(SETTINGS_READ_TIMEOUT_MS - 1000);
    reader.retry();
    assert.equal(sdk.requests.length, 1);
    assert.equal(clock.pendingTimers, 1, "one deadline, not two");
    clock.advance(1000);
    assert.equal(reader.state.read, "pending", "the first deadline was replaced");
    clock.advance(SETTINGS_READ_TIMEOUT_MS - 1000);
    assert.equal(reader.state.read, "timed_out");

    reader.retry();
    assert.deepEqual(
      [sdk.requests.length, reader.state.read, clock.pendingTimers],
      [1, "pending", 1],
    );
    await answer(sdk.requests[0], { a: 1 });
    assert.deepEqual(reader.state.known, { kind: "loaded", settings: { a: 1 } });
    assert.equal(clock.pendingTimers, 0);
  });

  it("an answer sent before a write began is stale and dropped; known stays", async () => {
    const { sdk, reader } = setup();
    reader.start();
    const ticket = reader.beginWrite();
    assert.deepEqual(ticket, { revision: 1 });
    assert.deepEqual(reader.state.known, { kind: "none" }, "a begun write changes nothing known");
    await answer(sdk.requests[0], { a: "old" });
    assert.deepEqual(reader.state, { known: { kind: "none" }, read: "idle", revision: 1 });
  });

  it("an accepted write becomes known only while nothing newer was applied", async () => {
    const { sdk, reader, changes } = setup();
    reader.start();
    await answer(sdk.requests[0], { a: 1 });
    const silent = changes();
    const first = reader.beginWrite();
    assert.ok(first);
    assert.equal(changes(), silent, "beginWrite calls no callback");
    const before = changes();
    assert.equal(reader.writeAccepted(first, { a: 2 }), 3, "applied at revision 3");
    assert.deepEqual(reader.state, {
      known: { kind: "loaded", settings: { a: 2 } },
      read: "idle",
      revision: 3,
    });
    assert.equal(changes(), before + 1);
    assert.equal(reader.writeAccepted(first, { a: 9 }), null, "a ticket applies once");

    const late = reader.beginWrite();
    assert.ok(late);
    sdk.emitOutside({ a: "outside" });
    assert.equal(reader.writeAccepted(late, { a: 3 }), null, "a late success never overwrites");
    assert.deepEqual(reader.state.known, { kind: "loaded", settings: { a: "outside" } });
  });

  it("after dispose no write begins and an accepted write changes nothing", async () => {
    const { sdk, reader, changes } = setup();
    reader.start();
    await answer(sdk.requests[0], { a: 1 });
    const ticket = reader.beginWrite();
    assert.ok(ticket);
    reader.dispose();
    const before = changes();
    assert.equal(reader.writeAccepted(ticket, { a: 2 }), null);
    assert.equal(reader.beginWrite(), null);
    assert.deepEqual(reader.state.known, { kind: "loaded", settings: { a: 1 } });
    assert.equal(changes(), before, "no callback after dispose");
  });

  it("an answer sent before an outside change is stale; the newer change stays", async () => {
    const { sdk, reader } = setup();
    reader.start();
    sdk.emitOutside({ a: "new" });
    assert.deepEqual(reader.state.known, { kind: "loaded", settings: { a: "new" } });
    await answer(sdk.requests[0], { a: "old" });
    assert.deepEqual(reader.state.known, { kind: "loaded", settings: { a: "new" } });
    assert.equal(reader.state.revision, 1);
  });

  it("one event that is both an outside change and the read's answer is applied once", async () => {
    // As the SDK delivers it: listeners run synchronously in order, the read
    // continues later. Both orders of the two listeners give one revision.
    for (const listenerFirst of [true, false]) {
      const { sdk, reader } = setup();
      reader.start();
      const event = { a: 1 };
      const request = sdk.requests[0];
      assert.ok(request);
      if (listenerFirst) sdk.emitOutside(event);
      request.resolve(event);
      if (!listenerFirst) sdk.emitOutside(event);
      await request.done;
      assert.deepEqual(reader.state, {
        known: { kind: "loaded", settings: event },
        read: "idle",
        revision: 1,
      });
    }
  });

  it("a malformed outside change is the newest state; an older answer cannot replace it", async () => {
    const { sdk, reader } = setup();
    reader.start();
    sdk.emitOutside(["not", "an", "object"]);
    assert.deepEqual(reader.state.known, { kind: "malformed" });
    await answer(sdk.requests[0], { a: "old but valid" });
    assert.deepEqual(reader.state.known, { kind: "malformed" });
    assert.equal(reader.state.revision, 1);
  });

  it("a malformed answer is known as malformed, never as a loaded object", async () => {
    for (const value of [null, "x", 5, [], Object.create({})]) {
      const { sdk, reader } = setup();
      reader.start();
      await answer(sdk.requests[0], value);
      assert.deepEqual(reader.state.known, { kind: "malformed" });
    }
  });

  it("a failed new read keeps the settings known before it", async () => {
    const { sdk, reader } = setup();
    reader.start();
    await answer(sdk.requests[0], { a: 1 });
    reader.retry();
    await refuse(sdk.requests[1]);
    assert.deepEqual(reader.state, {
      known: { kind: "loaded", settings: { a: 1 } },
      read: "failed",
      revision: 1,
    });
  });

  it("dispose while a read is pending: unsubscribed, no timer, later answers and events ignored", async () => {
    const { sdk, clock, reader, changes } = setup();
    reader.start();
    reader.dispose();
    assert.deepEqual([sdk.unsubscribed, clock.pendingTimers], [1, 0]);
    const before = changes();
    sdk.emitOutside({ a: 1 });
    sdk.emitThroughStaleListener({ a: 1 });
    await answer(sdk.requests[0], { a: 2 });
    reader.retry();
    assert.deepEqual(reader.state, { known: { kind: "none" }, read: "pending", revision: 0 });
    assert.deepEqual([sdk.requests.length, changes(), clock.pendingTimers], [1, before, 0]);
  });

  it("dispose after a timeout, with the SDK read still in flight: its answer is dropped", async () => {
    const { sdk, clock, reader, changes } = setup();
    reader.start();
    clock.advance(SETTINGS_READ_TIMEOUT_MS);
    reader.dispose();
    const before = changes();
    await answer(sdk.requests[0], { a: 1 });
    reader.retry();
    assert.deepEqual(reader.state.known, { kind: "none" });
    assert.deepEqual([sdk.requests.length, changes(), clock.pendingTimers], [1, before, 0]);
  });

  it("two readers keep their own settings", async () => {
    const first = setup();
    const second = setup();
    first.reader.start();
    second.reader.start();
    first.sdk.emitOutside({ who: "first" });
    await answer(second.sdk.requests[0], { who: "second" });
    assert.deepEqual(first.reader.state.known, { kind: "loaded", settings: { who: "first" } });
    assert.deepEqual(second.reader.state.known, { kind: "loaded", settings: { who: "second" } });
    await answer(first.sdk.requests[0], { who: "stale" });
    assert.deepEqual(first.reader.state.known, { kind: "loaded", settings: { who: "first" } });
  });
});
