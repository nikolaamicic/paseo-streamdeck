import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createShutdown,
  SHUTDOWN_GRACE_MS,
  type ShutdownOutcome,
} from "../../src/spike/shutdown.ts";
import { deferred, flush, ManualScheduler } from "../support/fake-client.ts";

function setup(stopRecovery: () => Promise<void>) {
  const clock = new ManualScheduler();
  const steps: string[] = [];
  const outcomes: ShutdownOutcome[] = [];
  const shutdown = createShutdown({
    disposeKeys: () => steps.push("dispose"),
    stopRecovery: () => {
      steps.push("stop");
      return stopRecovery();
    },
    exit: () => steps.push("exit"),
    timers: clock,
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  return { clock, steps, outcomes, shutdown };
}

describe("createShutdown", () => {
  it("disposes keys, waits for the recovery owner, then exits once", async () => {
    const stopped = deferred<undefined>();
    const { clock, steps, outcomes, shutdown } = setup(() => stopped.promise);
    assert.equal(shutdown.started, false);
    const first = shutdown.run();
    const second = shutdown.run();
    assert.equal(first, second);
    assert.equal(shutdown.started, true);
    await flush();
    assert.deepEqual(steps, ["dispose", "stop"], "no exit before the owner stopped");
    stopped.resolve(undefined);
    await first;
    assert.deepEqual(steps, ["dispose", "stop", "exit"]);
    assert.deepEqual(outcomes, ["clean"]);
    assert.equal(clock.pendingTimers, 0);
  });

  it("exits after the grace period when stopping hangs", async () => {
    const { clock, steps, outcomes, shutdown } = setup(() => new Promise(() => undefined));
    const running = shutdown.run();
    await flush();
    clock.advance(SHUTDOWN_GRACE_MS);
    await running;
    assert.deepEqual(steps, ["dispose", "stop", "exit"]);
    assert.deepEqual(outcomes, ["timeout"]);
  });

  it("still exits when stopping fails or the outcome sink throws", async () => {
    const { steps, outcomes, shutdown } = setup(() => Promise.reject(new Error("raw")));
    await shutdown.run();
    assert.deepEqual(steps, ["dispose", "stop", "exit"]);
    assert.deepEqual(outcomes, ["failed"]);

    let exited = 0;
    const throwing = createShutdown({
      disposeKeys: () => {
        throw new Error("dispose");
      },
      stopRecovery: () => Promise.resolve(),
      exit: () => (exited += 1),
      timers: new ManualScheduler(),
      onOutcome: () => {
        throw new Error("sink");
      },
    });
    await throwing.run();
    assert.equal(exited, 1);
  });
});
