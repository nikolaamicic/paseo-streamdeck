import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { within } from "../../src/paseo/deadline.ts";
import { deferred, flush, ManualScheduler } from "../support/fake-client.ts";

describe("within", () => {
  it("returns a value that arrives in time and clears its timer", async () => {
    const clock = new ManualScheduler();
    const result = within(Promise.resolve(7), 1000, clock).settled;
    assert.deepEqual(await result, { kind: "value", value: 7 });
    assert.equal(clock.pendingTimers, 0);
  });

  it("returns an error that arrives in time and clears its timer", async () => {
    const clock = new ManualScheduler();
    const failure = new Error("boom");
    assert.deepEqual(await within(Promise.reject(failure), 1000, clock).settled, {
      kind: "error",
      error: failure,
    });
    assert.equal(clock.pendingTimers, 0);
  });

  it("times out and ignores a late value or rejection", async () => {
    const clock = new ManualScheduler();
    const late = deferred<number>();
    const result = within(late.promise, 1000, clock).settled;
    clock.advance(999);
    await flush();
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await flush();
    assert.equal(settled, false);
    clock.advance(1);
    assert.deepEqual(await result, { kind: "timeout" });
    late.resolve(1);
    await flush();
    assert.deepEqual(await result, { kind: "timeout" });

    let rejectLate: (error: Error) => void = () => undefined;
    const lateFailure = new Promise<number>((_resolve, reject) => {
      rejectLate = reject;
    });
    const timedOut = within(lateFailure, 10, clock).settled;
    clock.advance(10);
    assert.deepEqual(await timedOut, { kind: "timeout" });
    rejectLate(new Error("late"));
    await flush();
    assert.equal(clock.pendingTimers, 0);
  });

  it("cancel() settles a hanging wait at once, clears the timer and ignores the late result", async () => {
    const clock = new ManualScheduler();
    const hanging = deferred<number>();
    const wait = within(hanging.promise, 1000, clock);
    assert.equal(clock.pendingTimers, 1);
    wait.cancel();
    assert.equal(clock.pendingTimers, 0);
    assert.deepEqual(await wait.settled, { kind: "cancelled" });
    hanging.resolve(1);
    wait.cancel();
    await flush();
    assert.deepEqual(await wait.settled, { kind: "cancelled" });
  });
});
