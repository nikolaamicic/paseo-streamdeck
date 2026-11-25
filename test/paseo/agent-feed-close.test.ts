import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentFeed, type FeedCloseOutcome } from "../../src/paseo/agent-feed.ts";
import { deferred, FakeClient, ManualScheduler } from "../support/fake-client.ts";
import { entry, snapshot } from "../support/paseo-payloads.ts";

/**
 * AgentFeed.close outcomes (C3b1) over FakeClient, which reports
 * "disposed" only once close has finished, like PaseoClient.close in
 * 0.15.4. "closed" is SDK disposal confirmation only, not a closed socket.
 */

const RELEASED_AND_CLOSED: FeedCloseOutcome = { subscriptions: "released", client: "closed" };

async function started() {
  const client = new FakeClient();
  client.initialSnapshot = snapshot([entry({ id: "a" })]);
  let changes = 0;
  const feed = new AgentFeed(
    client,
    {
      onChange: () => {
        changes += 1;
      },
      onSnapshot: () => {
        changes += 1;
      },
    },
    { scheduler: new ManualScheduler() },
  );
  await feed.start();
  return { client, feed, changes: () => changes };
}

describe("AgentFeed.close outcome", () => {
  it("a clean close: subscriptions released, client closed (disposed)", async () => {
    const { client, feed } = await started();
    assert.deepEqual(await feed.close(), RELEASED_AND_CLOSED);
    assert.equal(client.getConnectionState().status, "disposed");
  });

  it("a failed unsubscribe or release does not hide a confirmed client close", async () => {
    for (const fail of ["unsubscribe", "release"] as const) {
      const { client, feed } = await started();
      if (fail === "unsubscribe") client.unsubscribeError = new Error("raw unsubscribe");
      else client.releaseError = new Error("raw release");
      const outcome = await feed.close();
      assert.deepEqual(outcome, { subscriptions: "failed", client: "closed" });
      assert.doesNotMatch(JSON.stringify(outcome), /raw/);
      assert.equal(client.closed, 1, "the client is still closed");
    }
  });

  it("a rejected client.close is unconfirmed, even when the state says disposed", async () => {
    for (const disposes of [true, false]) {
      const { client, feed } = await started();
      client.closeError = new Error("raw close");
      client.closeErrorDisposes = disposes;
      assert.deepEqual(await feed.close(), { subscriptions: "released", client: "failed" });
      assert.equal(client.getConnectionState().status === "disposed", disposes);
    }
  });

  it("a close that resolves without disposed, or a throwing state getter, is unconfirmed", async () => {
    const notDisposed = await started();
    notDisposed.client.closeLeavesState = true;
    assert.deepEqual(await notDisposed.feed.close(), {
      subscriptions: "released",
      client: "failed",
    });

    const throwing = await started();
    throwing.client.stateError = new Error("raw getter");
    const outcome = await throwing.feed.close();
    assert.deepEqual(outcome, { subscriptions: "released", client: "failed" });
    assert.doesNotMatch(JSON.stringify(outcome), /raw/);
  });

  it("every close call before, during and after the cleanup gets the same one outcome", async () => {
    const { client, feed, changes } = await started();
    const gate = deferred<undefined>();
    client.closeGate = gate.promise.then(() => undefined);
    const first = feed.close();
    // Events stop synchronously, before the asynchronous cleanup.
    const before = changes();
    client.emitSnapshot(snapshot([entry({ id: "b" })]));
    assert.equal(changes(), before, "no event after close began");
    const second = feed.close();
    assert.equal(second, first, "the same promise while the close is pending");
    assert.equal(client.getConnectionState().status === "disposed", false, "not yet disposed");
    gate.resolve(undefined);
    const outcome = await first;
    assert.equal(await second, outcome);
    assert.equal(client.closed, 1, "one client.close for both calls");
    const third = feed.close();
    assert.equal(third, first, "and the same after it finished");
    assert.deepEqual(await third, RELEASED_AND_CLOSED);
    assert.equal(client.closed, 1);
  });

  it("a close before start closes the client and reports it", async () => {
    const client = new FakeClient();
    const feed = new AgentFeed(client, {}, { scheduler: new ManualScheduler() });
    assert.deepEqual(await feed.close(), RELEASED_AND_CLOSED);
    assert.equal(client.closed, 1);
  });
});
