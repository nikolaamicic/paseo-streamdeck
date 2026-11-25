import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DirectoryChange } from "../../src/agents/agent-directory.ts";
import { agentKey } from "../../src/agents/agent-model.ts";
import {
  AgentFeed,
  AgentFeedError,
  RESYNC_HOST_TIMEOUT_MS,
  type AgentFeedListener,
  type FeedWarning,
} from "../../src/paseo/agent-feed.ts";
import type { LinkState } from "../../src/paseo/link-state.ts";
import { UsagePoller } from "../../src/usage/usage-poller.ts";
import { deferred, FakeClient, flush, ManualScheduler } from "../support/fake-client.ts";
import {
  agentPayload,
  entry,
  projectPayload,
  SERVER_ID,
  snapshot,
} from "../support/paseo-payloads.ts";

interface Recorded {
  changes: DirectoryChange[];
  snapshots: DirectoryChange[][];
  links: { state: LinkState; stale: boolean }[];
  warnings: string[];
  warningObjects: FeedWarning[];
  failures: string[];
}

function setup(initial: unknown[] = [entry({ id: "a" }), entry({ id: "b" })]) {
  const client = new FakeClient();
  client.initialSnapshot = snapshot(initial);
  const scheduler = new ManualScheduler();
  const recorded: Recorded = {
    changes: [],
    snapshots: [],
    links: [],
    warnings: [],
    warningObjects: [],
    failures: [],
  };
  const listener: AgentFeedListener = {
    onChange: (change) => recorded.changes.push(change),
    onSnapshot: (changes) => recorded.snapshots.push([...changes]),
    onLinkState: (state, stale) => recorded.links.push({ state, stale }),
    onWarning: (warning) => {
      recorded.warnings.push(warning.code);
      recorded.warningObjects.push(warning);
    },
    onFailure: (error) => recorded.failures.push(error.code),
  };
  const feed = new AgentFeed(client, listener, { scheduler });
  return { client, scheduler, recorded, feed };
}

const key = (agentId: string, serverId = SERVER_ID) => agentKey({ serverId, agentId });

async function reconnect(client: FakeClient, scheduler: ManualScheduler): Promise<void> {
  client.state = { status: "disconnected", reason: "Transport closed" };
  scheduler.tick();
  client.state = { status: "connected" };
  scheduler.tick();
  await flush();
}

describe("AgentFeed start and snapshot", () => {
  it("subscribes once with the maximum page and resolves after the first snapshot", async () => {
    const { client, feed } = setup();
    await feed.start();
    assert.deepEqual(client.listCalls, [{ subscribe: {}, page: { limit: 200 } }]);
    assert.equal(feed.serverId, SERVER_ID);
    assert.deepEqual(
      feed.agents().map((agent) => agent.address),
      [
        { serverId: SERVER_ID, agentId: "a" },
        { serverId: SERVER_ID, agentId: "b" },
      ],
    );
    assert.equal(feed.snapshotsApplied, 1);
    assert.equal(feed.stale, false);
    assert.equal(feed.truncated, false);
    await feed.close();
  });

  it("requests archived and background agents only when asked", async () => {
    const client = new FakeClient();
    const feed = new AgentFeed(
      client,
      {},
      { scheduler: new ManualScheduler(), includeArchived: true, includeBackground: true },
    );
    await feed.start();
    assert.deepEqual(client.listCalls, [
      {
        subscribe: {},
        page: { limit: 200 },
        includeBackground: true,
        filter: { includeArchived: true },
      },
    ]);
    await feed.close();
  });

  it("skips malformed entries and flags a truncated directory visibly", async () => {
    const { client, feed, recorded } = setup();
    client.initialSnapshot = snapshot([entry({ id: "ok" }), { agent: { id: "broken" } }], true);
    await feed.start();
    assert.equal(feed.directory.size, 1);
    assert.equal(feed.truncated, true);
    assert.ok(recorded.warnings.includes("page_truncated"));
    assert.ok(
      recorded.warningObjects.some(
        (warning) => warning.code === "entry_skipped" && warning.detail === "missing_provider",
      ),
    );
    await feed.close();
  });

  it("ignores a snapshot with an unexpected shape", async () => {
    const { client, feed, recorded } = setup();
    await feed.start();
    client.emitSnapshot({ items: [] });
    await flush();
    assert.equal(feed.directory.size, 2);
    assert.ok(recorded.warnings.includes("snapshot_invalid"));
    await feed.close();
  });
});

describe("AgentFeed updates", () => {
  it("reports only real changes for upserts and removes", async () => {
    const { client, feed, recorded } = setup();
    await feed.start();

    client.emitUpdate({
      kind: "upsert",
      agent: agentPayload({ id: "a" }),
      project: projectPayload(),
    });
    await flush();
    assert.equal(recorded.changes.length, 0, "an identical upsert is not a change");

    client.emitUpdate({ kind: "upsert", agent: agentPayload({ id: "c" }), project: null });
    client.emitUpdate({ kind: "remove", agentId: "b" });
    client.emitUpdate({ kind: "remove", agentId: "never-existed" });
    await flush();
    assert.deepEqual(
      recorded.changes.map((change) => [change.kind, change.key]),
      [
        ["added", key("c")],
        ["removed", key("b")],
      ],
    );
    await feed.close();
  });

  it("keeps the project when an update omits it and clears it on explicit null", async () => {
    const { client, feed } = setup([entry({ id: "a" })]);
    await feed.start();
    const address = { serverId: SERVER_ID, agentId: "a" };

    client.emitUpdate({ kind: "upsert", agent: agentPayload({ id: "a", status: "running" }) });
    await flush();
    assert.equal(feed.directory.get(address)?.status, "running");
    assert.equal(feed.directory.get(address)?.project?.name, "Test project");

    client.emitUpdate({ kind: "upsert", agent: agentPayload({ id: "a" }), project: null });
    await flush();
    assert.equal(feed.directory.get(address)?.project, null);
    await feed.close();
  });

  it("reports metadata-only changes such as updatedAt as directory changes", async () => {
    const { client, feed, recorded } = setup([entry({ id: "a" })]);
    await feed.start();
    client.emitUpdate({
      kind: "upsert",
      agent: agentPayload({ id: "a", updatedAt: "2026-11-14T10:05:00.000Z" }),
      project: projectPayload(),
    });
    await flush();
    assert.equal(recorded.changes.at(-1)?.kind, "updated");
    await feed.close();
  });

  it("ignores malformed updates and non-agent messages with a warning", async () => {
    const { client, feed, recorded } = setup();
    await feed.start();
    client.emitUpdate({ kind: "upsert", agent: { id: "x" } });
    for (const observer of client.observers) {
      observer.update({ type: "workspace_update", payload: {} });
      observer.update("not an object");
    }
    await flush();
    assert.equal(recorded.changes.length, 0);
    assert.equal(recorded.warnings.length, 1);
    await feed.close();
  });
});

describe("AgentFeed connection and reconnect", () => {
  it("marks data stale on link loss and reconciles the reconnect snapshot", async () => {
    const { client, scheduler, feed, recorded } = setup();
    await feed.start();

    client.state = { status: "disconnected", reason: "Transport closed" };
    scheduler.tick();
    assert.equal(feed.linkState.kind, "reconnecting");
    assert.equal(feed.stale, true);
    assert.equal(feed.directory.size, 2, "last known agents stay visible");

    client.state = { status: "connected" };
    scheduler.tick();
    assert.equal(feed.stale, true, "still stale until the fresh snapshot is applied");

    client.emitSnapshot(snapshot([entry({ id: "b", status: "running" }), entry({ id: "c" })]));
    await flush();
    assert.equal(feed.stale, true, "the workspace snapshot of this reconnect is still missing");
    client.workspaces.emitSnapshot(snapshot([]));
    await flush();
    assert.equal(feed.stale, false);
    assert.equal(feed.snapshotsApplied, 2);
    assert.equal(feed.workspaceSnapshotsApplied, 2);
    assert.deepEqual(
      recorded.snapshots[1]?.map((change) => [change.kind, change.key]),
      [
        ["removed", key("a")],
        ["updated", key("b")],
        ["added", key("c")],
      ],
    );
    assert.equal(client.listCalls.length, 1, "reconnect must not create a second subscription");
    assert.equal(client.workspaces.listCalls.length, 1);
    assert.deepEqual(
      recorded.links.map((link) => [link.state.kind, link.stale]),
      [
        ["connected", false],
        // During start the agent directory is applied before the workspace
        // one; that partial data is stale until both are in.
        ["connected", true],
        ["connected", false],
        ["reconnecting", true],
        ["connected", true],
        ["connected", false],
      ],
    );
    await feed.close();
  });

  it("applies updates that arrive during a reconnect snapshot after that snapshot", async () => {
    const { client, scheduler, feed } = setup();
    await feed.start();
    await reconnect(client, scheduler);

    const gate = deferred<undefined>();
    client.hostsListGate = gate.promise;
    client.emitSnapshot(snapshot([entry({ id: "a" })]));
    client.emitUpdate({ kind: "upsert", agent: agentPayload({ id: "a", status: "running" }) });
    await flush();
    assert.equal(feed.snapshotsApplied, 1, "the snapshot waits for the host identity");

    gate.resolve(undefined);
    await flush();
    assert.equal(feed.snapshotsApplied, 2);
    assert.equal(feed.directory.get({ serverId: SERVER_ID, agentId: "a" })?.status, "running");
    await feed.close();
  });

  it("re-keys the directory when a reconnect reaches a different daemon", async () => {
    const { client, scheduler, feed, recorded } = setup([entry({ id: "a" })]);
    await feed.start();
    await reconnect(client, scheduler);
    client.serverId = "srv_OtherDaemon";
    client.emitSnapshot(snapshot([entry({ id: "a" })]));
    await flush();
    assert.equal(feed.serverId, "srv_OtherDaemon");
    assert.deepEqual(
      recorded.snapshots[1]?.map((change) => [change.kind, change.key]),
      [
        ["removed", key("a")],
        ["added", key("a", "srv_OtherDaemon")],
      ],
    );
    assert.ok(recorded.warnings.includes("server_changed"));
    await feed.close();
  });

  it("reports an authentication failure and cleans up after a rejected start", async () => {
    const { client, scheduler, feed, recorded } = setup();
    client.connectError = new Error("Incorrect password");
    await assert.rejects(feed.start(), (error: unknown) => {
      return error instanceof AgentFeedError && error.code === "auth_failed";
    });
    scheduler.tick();
    assert.equal(feed.linkState.kind, "auth_failed");
    assert.equal(client.listCalls.length, 0);
    await feed.close();
    assert.equal(scheduler.active, 0);
    assert.equal(client.closed, 1);
    assert.equal(recorded.snapshots.length, 0);
  });
});

describe("AgentFeed first snapshot", () => {
  it("accepts a valid empty first snapshot as a healthy empty directory", async () => {
    const { feed, recorded } = setup([]);
    await feed.start();
    assert.equal(feed.directory.size, 0);
    assert.equal(feed.snapshotsApplied, 1);
    assert.equal(feed.failure, null);
    assert.equal(feed.stale, false);
    assert.equal(recorded.failures.length, 0);
    await feed.close();
  });

  it("fails start terminally on a malformed first snapshot, without leaking it", async () => {
    const MARKER = "SENSITIVE-SENTINEL-c41f";
    const { client, scheduler, feed, recorded } = setup();
    client.initialSnapshot = { items: [`${MARKER} /Users/someone/private`] };
    let error: unknown = null;
    try {
      await feed.start();
    } catch (caught: unknown) {
      error = caught;
    }
    assert.ok(error instanceof AgentFeedError && error.code === "initial_snapshot_invalid");
    assert.equal(error.cause, undefined);
    assert.equal(feed.failure, "initial_snapshot_invalid");
    assert.deepEqual(recorded.failures, ["initial_snapshot_invalid"]);
    assert.ok(recorded.warnings.includes("snapshot_invalid"));
    assert.equal(feed.snapshotsApplied, 0);
    assert.equal(feed.directory.size, 0);
    const exposed = JSON.stringify([
      recorded.links,
      recorded.warningObjects,
      recorded.failures,
      error.message,
      String(error.stack),
    ]);
    assert.equal(exposed.includes(MARKER), false);

    await feed.close();
    assert.equal(client.released, 1);
    assert.equal(client.closed, 1);
    assert.equal(client.observers.size, 0);
    assert.equal(scheduler.active, 0);
  });

  it("ignores snapshots and updates that arrive after the terminal first-snapshot failure", async () => {
    const { client, feed, recorded } = setup();
    client.initialSnapshot = { items: [] };
    await assert.rejects(feed.start());
    client.emitSnapshot(snapshot([entry({ id: "late" })]));
    client.emitUpdate({ kind: "upsert", agent: agentPayload({ id: "late-2" }), project: null });
    await flush();
    assert.equal(feed.directory.size, 0);
    assert.equal(feed.snapshotsApplied, 0);
    assert.equal(recorded.snapshots.length, 0);
    assert.equal(recorded.changes.length, 0);
    assert.equal(feed.failure, "initial_snapshot_invalid");
    await feed.close();
  });

  it("does not treat a malformed resync snapshot as terminal", async () => {
    const { client, feed } = setup();
    await feed.start();
    client.emitSnapshot({ items: [] });
    await flush();
    assert.equal(feed.failure, null);
    assert.equal(feed.stale, true);
    assert.equal(feed.directory.size, 2);
    client.emitSnapshot(snapshot([entry({ id: "a" })]));
    client.workspaces.emitSnapshot(snapshot([]));
    await flush();
    assert.equal(feed.stale, false);
    assert.equal(feed.directory.size, 1);
    await feed.close();
  });
});

describe("AgentFeed reconnect snapshot freshness", () => {
  it("marks data stale when a reconnect snapshot arrives, even if no disconnect was polled", async () => {
    const { client, feed, recorded } = setup();
    await feed.start();
    const gate = deferred<undefined>();
    client.hostsListGate = gate.promise;

    client.emitSnapshot(snapshot([entry({ id: "a" })]));
    assert.equal(feed.linkState.kind, "connected", "the poll never saw a disconnect");
    assert.equal(feed.stale, true, "stale on receipt, before the async host lookup");
    assert.deepEqual(recorded.links.at(-1), { state: { kind: "connected" }, stale: true });

    await flush();
    assert.equal(feed.stale, true, "still stale while the host identity is pending");
    gate.resolve(undefined);
    await flush();
    assert.equal(feed.snapshotsApplied, 2);
    assert.equal(feed.stale, true, "the workspace snapshot of the same reconnect is missing");
    client.workspaces.emitSnapshot(snapshot([]));
    await flush();
    assert.equal(feed.stale, false);
    assert.deepEqual(recorded.links.at(-1), { state: { kind: "connected" }, stale: false });
    await feed.close();
  });

  it("keeps data stale when the host identity lookup for a resync fails", async () => {
    const { client, feed } = setup();
    await feed.start();
    client.hostsListError = new Error("host lookup failed");
    client.emitSnapshot(snapshot([entry({ id: "a" })]));
    await flush();
    assert.equal(feed.stale, true);
    assert.equal(feed.directory.size, 2, "previous data is kept, not replaced");
    assert.equal(feed.snapshotsApplied, 1);

    client.hostsListError = null;
    client.emitSnapshot(snapshot([entry({ id: "a" })]));
    client.workspaces.emitSnapshot(snapshot([]));
    await flush();
    assert.equal(feed.stale, false, "later applied snapshots clear it");
    assert.equal(feed.directory.size, 1);
  });

  it("bounds a hanging resync host lookup without blocking the queue", async () => {
    const { client, scheduler, feed, recorded } = setup();
    await feed.start();
    const hanging = deferred<undefined>();
    client.hostsListGates = [hanging.promise];
    client.emitSnapshot(snapshot([entry({ id: "c" })]));
    await flush();
    assert.equal(feed.stale, true);
    scheduler.advance(RESYNC_HOST_TIMEOUT_MS - 1);
    await flush();
    assert.equal(recorded.warnings.includes("resync_failed"), false, "not before the deadline");

    scheduler.advance(1);
    await flush();
    assert.ok(recorded.warnings.includes("resync_failed"));
    assert.equal(feed.snapshotsApplied, 1, "the previous data is kept");
    assert.equal(feed.stale, true, "and not presented as fresh");
    assert.equal(scheduler.pendingTimers, 0);

    client.emitUpdate({ kind: "upsert", agent: agentPayload({ id: "a", status: "running" }) });
    await flush();
    assert.equal(feed.directory.get({ serverId: SERVER_ID, agentId: "a" })?.status, "running");

    hanging.resolve(undefined);
    await flush();
    assert.equal(feed.snapshotsApplied, 1, "the late host identity is ignored");
    assert.equal(feed.stale, true);

    client.emitSnapshot(snapshot([entry({ id: "c" })]));
    client.workspaces.emitSnapshot(snapshot([]));
    await flush();
    assert.equal(feed.snapshotsApplied, 2);
    assert.equal(feed.stale, false);
    await feed.close();
  });

  it("cancels a pending resync host deadline on close", async () => {
    const { client, scheduler, feed } = setup();
    await feed.start();
    client.hostsListGates = [new Promise(() => undefined)];
    client.emitSnapshot(snapshot([entry({ id: "c" })]));
    await flush();
    assert.equal(scheduler.pendingTimers, 1);
    await feed.close();
    assert.equal(scheduler.pendingTimers, 0);
  });

  it("keeps data stale after a malformed resync snapshot", async () => {
    const { client, feed } = setup();
    await feed.start();
    client.emitSnapshot({ items: [] });
    await flush();
    assert.equal(feed.stale, true);
    assert.equal(feed.directory.size, 2);
    await feed.close();
  });

  it("stays stale until the last of several queued snapshots is applied", async () => {
    const { client, feed } = setup();
    await feed.start();
    const first = deferred<undefined>();
    const second = deferred<undefined>();
    client.hostsListGates = [first.promise, second.promise];
    client.emitSnapshot(snapshot([entry({ id: "a" })]));
    client.emitSnapshot(snapshot([entry({ id: "b" })]));
    assert.equal(feed.stale, true);

    first.resolve(undefined);
    await flush();
    assert.equal(feed.snapshotsApplied, 2, "the first resync snapshot is applied");
    assert.equal(feed.stale, true, "the second one is still pending");

    second.resolve(undefined);
    await flush();
    assert.equal(feed.snapshotsApplied, 3);
    assert.equal(feed.stale, true, "no workspace snapshot of the latest round yet");
    client.workspaces.emitSnapshot(snapshot([]));
    await flush();
    assert.equal(feed.stale, false);
    assert.deepEqual(
      feed.agents().map((agent) => agent.address.agentId),
      ["b"],
    );
    await feed.close();
  });
});

describe("AgentFeed diagnostics never expose raw error text or payload values", () => {
  // Synthetic stand-in for what an SDK/transport error could carry: a URL
  // with credentials, a private path and a terminal control sequence.
  const SENTINEL =
    "SENSITIVE-SENTINEL-4d1e ws://user:pw@127.0.0.1/ws /Users/someone/private \u001b[2J";
  const MARKER = "SENSITIVE-SENTINEL-4d1e";

  function exposed(recorded: Recorded, extra: unknown[] = []): string {
    return JSON.stringify([
      recorded.links,
      recorded.warningObjects,
      recorded.failures,
      ...extra.map((value) =>
        value instanceof Error
          ? {
              name: value.name,
              message: value.message,
              cause: String(value.cause),
              stack: value.stack,
            }
          : value,
      ),
    ]);
  }

  async function startError(feed: AgentFeed): Promise<unknown> {
    try {
      await feed.start();
    } catch (error: unknown) {
      return error;
    }
    return null;
  }

  it("connect failure and connection reason", async () => {
    const { client, scheduler, feed, recorded } = setup();
    client.connectError = new Error(SENTINEL);
    const error = await startError(feed);
    scheduler.tick();
    assert.ok(error instanceof AgentFeedError && error.code === "connect_failed");
    assert.equal(error.cause, undefined);
    assert.equal(exposed(recorded, [error, feed.linkState]).includes(MARKER), false);
    await feed.close();
  });

  it("disconnect reason while connected", async () => {
    const { client, scheduler, feed, recorded } = setup();
    await feed.start();
    client.state = { status: "disconnected", reason: SENTINEL };
    scheduler.tick();
    assert.equal(feed.linkState.kind, "reconnecting");
    assert.equal(exposed(recorded, [feed.linkState]).includes(MARKER), false);
    await feed.close();
  });

  it("rejects a server identity that is not well-formed text", async () => {
    const { client, feed } = setup();
    client.serverId = "srv_\uD800";
    const error = await startError(feed);
    assert.ok(error instanceof AgentFeedError);
    assert.equal(error.code, "host_identity_failed");
    await feed.close();
  });

  it("host identity and subscribe failures at start", async () => {
    for (const failWhere of ["hosts", "list"] as const) {
      const { client, feed, recorded } = setup();
      if (failWhere === "hosts") client.hostsListError = new Error(SENTINEL);
      else {
        client.agents.list = () => Promise.reject(new Error(SENTINEL));
      }
      const error = await startError(feed);
      assert.ok(error instanceof AgentFeedError);
      assert.equal(error.code, failWhere === "hosts" ? "host_identity_failed" : "subscribe_failed");
      assert.equal(exposed(recorded, [error]).includes(MARKER), false);
      await feed.close();
    }
  });

  it("subscription errors, including non-Error values", async () => {
    for (const thrown of [new Error(SENTINEL), SENTINEL, { message: SENTINEL }]) {
      const { client, feed, recorded } = setup();
      await feed.start();
      client.emitError(thrown);
      await flush();
      assert.equal(feed.failure, "subscription_failed");
      assert.equal(exposed(recorded, [feed.failure]).includes(MARKER), false);
      await feed.close();
    }
  });

  it("resync host lookup failure", async () => {
    const { client, feed, recorded } = setup();
    await feed.start();
    client.hostsListError = new Error(SENTINEL);
    client.emitSnapshot(snapshot([entry({ id: "a" })]));
    await flush();
    assert.ok(recorded.warnings.includes("resync_failed"));
    assert.equal(exposed(recorded).includes(MARKER), false);
    await feed.close();
  });

  it("listener errors", async () => {
    const client = new FakeClient();
    client.initialSnapshot = snapshot([entry({ id: "a" })]);
    const warnings: FeedWarning[] = [];
    const feed = new AgentFeed(
      client,
      {
        onSnapshot: () => {
          throw new Error(SENTINEL);
        },
        onWarning: (warning) => warnings.push(warning),
      },
      { scheduler: new ManualScheduler() },
    );
    await feed.start();
    assert.deepEqual(
      warnings.map((warning) => warning.code),
      ["listener_failed"],
    );
    assert.equal(JSON.stringify(warnings).includes(MARKER), false);
    await feed.close();
  });

  it("invalid agent IDs and payload values in skipped entries and ignored updates", async () => {
    const { client, feed, recorded } = setup([
      entry({ id: SENTINEL, provider: null }),
      entry({ id: "ok" }),
    ]);
    await feed.start();
    client.emitUpdate({ kind: "upsert", agent: agentPayload({ id: SENTINEL, status: 42 }) });
    client.emitUpdate({ kind: SENTINEL });
    await flush();
    assert.deepEqual(recorded.warnings, ["entry_skipped", "update_ignored", "update_ignored"]);
    assert.equal(exposed(recorded).includes(MARKER), false);
    await feed.close();
  });
});

describe("AgentFeed cleanup and registration failures", () => {
  const SENTINEL = "SENSITIVE-SENTINEL-77b2 ws://user:pw@127.0.0.1/ws /Users/someone/private";
  const MARKER = "SENSITIVE-SENTINEL-77b2";

  function leaks(error: unknown): boolean {
    if (!(error instanceof Error)) return JSON.stringify(error).includes(MARKER);
    return [error.message, String(error.stack), String(error.cause), JSON.stringify(error)].some(
      (text) => text.includes(MARKER),
    );
  }

  async function rejection(promise: Promise<void>): Promise<unknown> {
    try {
      await promise;
    } catch (error: unknown) {
      return error;
    }
    assert.fail("expected a rejection");
  }

  it("still closes the client when releasing the subscription fails", async () => {
    const { client, scheduler, feed } = setup();
    await feed.start();
    client.releaseError = new Error(SENTINEL);
    // C3b1: the outcome tells the failed release apart from the client.
    const outcome = await feed.close();
    assert.deepEqual(outcome, { subscriptions: "failed", client: "closed" });
    assert.equal(leaks(outcome), false);
    assert.equal(client.released, 1);
    assert.equal(client.closed, 1, "the connection is closed despite the failed release");
    assert.equal(scheduler.active, 0);
    assert.equal(client.observers.size, 0);
    await feed.close();
    assert.equal(client.closed, 1, "a second close has no effect");
  });

  it("reports a failing client.close without its aggregate content", async () => {
    const { client, feed } = setup();
    await feed.start();
    client.closeError = new AggregateError([new Error(SENTINEL)], SENTINEL);
    // C3b1: a rejected client.close is an unconfirmed close, not an error.
    const outcome = await feed.close();
    assert.deepEqual(outcome, { subscriptions: "released", client: "failed" });
    assert.equal(leaks(outcome), false);
    assert.equal(client.released, 1);
  });

  it("keeps 'closed' as the start result when a late release fails", async () => {
    const { client, feed } = setup();
    const gate = deferred<undefined>();
    client.listGate = gate.promise;
    const starting = feed.start();
    await flush();
    await feed.close();
    client.releaseError = new Error(SENTINEL);
    gate.resolve(undefined);
    const error = await rejection(starting);
    assert.ok(error instanceof AgentFeedError && error.code === "closed");
    assert.equal(leaks(error), false);
    assert.equal(client.released, 1, "the late subscription is still released");
  });

  it("maps a synchronous subscribe failure to a stable code and releases it on close", async () => {
    const { client, scheduler, feed } = setup();
    client.subscribeError = new Error(SENTINEL);
    const error = await rejection(feed.start());
    assert.ok(error instanceof AgentFeedError && error.code === "subscribe_failed");
    assert.equal(leaks(error), false);
    await feed.close();
    assert.equal(client.released, 1);
    assert.equal(client.closed, 1);
    assert.equal(scheduler.active, 0);
  });
});

describe("AgentFeed start/close races", () => {
  it("refuses to start after close, before creating any resource", async () => {
    const { client, scheduler, feed, recorded } = setup();
    await feed.close();
    await assert.rejects(feed.start(), (error: unknown) => {
      return error instanceof AgentFeedError && error.code === "closed";
    });
    assert.equal(scheduler.active, 0);
    assert.equal(client.connectCalls, 0);
    assert.equal(client.listCalls.length, 0);
    assert.equal(recorded.links.length, 0);
    await feed.close();
    assert.equal(client.closed, 1, "close stays idempotent");
  });

  it("stops after close while the initial host identity is pending", async () => {
    const { client, scheduler, feed, recorded } = setup();
    const gate = deferred<undefined>();
    client.hostsListGate = gate.promise;
    const starting = feed.start();
    await flush();
    const linksBefore = recorded.links.length;
    await feed.close();
    gate.resolve(undefined);
    await assert.rejects(starting, (error: unknown) => {
      return error instanceof AgentFeedError && error.code === "closed";
    });
    assert.equal(client.listCalls.length, 0, "no list request after close");
    assert.equal(feed.serverId, null, "no state mutation after close");
    assert.equal(feed.directory.size, 0);
    assert.equal(scheduler.active, 0);
    assert.equal(recorded.links.length, linksBefore);
  });

  it("releases a subscription that arrives after close", async () => {
    const { client, scheduler, feed, recorded } = setup();
    const gate = deferred<undefined>();
    client.listGate = gate.promise;
    const starting = feed.start();
    await flush();
    assert.equal(client.listCalls.length, 1);
    await feed.close();
    gate.resolve(undefined);
    await assert.rejects(starting, (error: unknown) => {
      return error instanceof AgentFeedError && error.code === "closed";
    });
    assert.equal(client.released, 1);
    assert.equal(client.observers.size, 0);
    assert.equal(feed.directory.size, 0);
    assert.equal(recorded.snapshots.length, 0);
    assert.equal(scheduler.active, 0);
  });

  it("rejects a start that is waiting for its first snapshot when closed", async () => {
    const { client, scheduler, feed } = setup();
    client.deliverInitialSnapshot = false;
    const starting = feed.start();
    await flush();
    await feed.close();
    await assert.rejects(starting, (error: unknown) => {
      return error instanceof AgentFeedError && error.code === "closed";
    });
    assert.equal(client.released, 1);
    assert.equal(scheduler.active, 0);
  });
});

describe("AgentFeed failures and lifecycle", () => {
  it("surfaces a failed subscription, keeps data marked stale and does not retry on its own", async () => {
    const { client, feed, recorded } = setup();
    await feed.start();
    client.emitError(new Error("observation rejected"));
    await flush();
    assert.deepEqual(recorded.failures, ["subscription_failed"]);
    assert.equal(feed.failure, "subscription_failed");
    assert.equal(feed.stale, true);
    assert.equal(feed.directory.size, 2);
    assert.equal(client.listCalls.length, 1);
    assert.equal(recorded.links.at(-1)?.stale, true);
    await feed.close();
  });

  it("rejects start when the subscription fails before the first snapshot", async () => {
    const { client, feed } = setup();
    client.initialSnapshot = undefined;
    const original = client.agents.list;
    client.agents.list = async (options) => {
      const result = await original(options);
      return {
        subscription: {
          subscribe: (observer) => {
            observer.error?.(new Error("establishment failed"));
            return () => undefined;
          },
          release: () => result.subscription.release(),
        },
      };
    };
    await assert.rejects(feed.start(), (error: unknown) => {
      return error instanceof AgentFeedError && error.code === "subscription_failed";
    });
    await feed.close();
  });

  it("does not let a throwing listener break polling or updates", async () => {
    const client = new FakeClient();
    client.initialSnapshot = snapshot([entry({ id: "a" })]);
    const scheduler = new ManualScheduler();
    const warnings: FeedWarning[] = [];
    const feed = new AgentFeed(
      client,
      {
        onLinkState: () => {
          throw new Error("render failed");
        },
        onChange: () => {
          throw new Error("render failed");
        },
        onWarning: (message) => warnings.push(message),
      },
      { scheduler },
    );
    await feed.start();
    client.state = { status: "disconnected" };
    assert.doesNotThrow(() => {
      scheduler.tick();
    });
    client.emitUpdate({ kind: "remove", agentId: "a" });
    await flush();
    assert.equal(feed.directory.size, 0);
    assert.ok(warnings.some((warning) => warning.code === "listener_failed"));
    await feed.close();
  });

  it("cleans up polling, subscription and connection on close, idempotently", async () => {
    const { client, scheduler, feed } = setup();
    await feed.start();
    await feed.close();
    await feed.close();
    assert.equal(scheduler.active, 0);
    assert.equal(client.observers.size, 0);
    assert.equal(client.released, 1);
    assert.equal(client.closed, 1);
  });

  it("applies and reports nothing after close, including a pending reconnect snapshot", async () => {
    const { client, scheduler, feed, recorded } = setup();
    await feed.start();
    await reconnect(client, scheduler);
    const gate = deferred<undefined>();
    client.hostsListGate = gate.promise;
    const observers = [...client.observers];
    for (const observer of observers) observer.snapshot(snapshot([]));
    await flush();

    const before = {
      size: feed.directory.size,
      snapshots: recorded.snapshots.length,
      links: recorded.links.length,
      warnings: recorded.warnings.length,
    };
    await feed.close();
    gate.resolve(undefined);
    for (const observer of observers) {
      observer.update({ type: "agent_update", payload: { kind: "remove", agentId: "a" } });
      observer.error?.(new Error("late"));
    }
    scheduler.tick();
    await flush();
    assert.deepEqual(
      {
        size: feed.directory.size,
        snapshots: recorded.snapshots.length,
        links: recorded.links.length,
        warnings: recorded.warnings.length,
      },
      before,
    );
    assert.equal(recorded.failures.length, 0);
  });

  it("stops cleanly when closed while the daemon is still unreachable", async () => {
    const { client, scheduler, feed } = setup();
    const gate = deferred<undefined>();
    client.connectGate = gate.promise;
    const starting = feed.start();
    await flush();
    await feed.close();
    gate.resolve(undefined);
    await assert.rejects(starting);
    assert.equal(client.listCalls.length, 0);
    assert.equal(scheduler.active, 0);
  });

  it("can only be started once and validates the page limit", async () => {
    const { feed } = setup();
    await feed.start();
    await assert.rejects(feed.start());
    await feed.close();
    assert.throws(() => new AgentFeed(new FakeClient(), {}, { pageLimit: 201 }), RangeError);
    assert.throws(() => new AgentFeed(new FakeClient(), {}, { pageLimit: 0 }), RangeError);
  });
});

describe("AgentFeed.listUsage", () => {
  it("asks the feed's own client and refuses after close", async () => {
    const { client, feed } = setup();
    await feed.start();
    const answer = { providers: [] };
    client.usageAnswers.push(Promise.resolve(answer));
    assert.equal(await feed.listUsage(), answer);
    assert.equal(client.usageCalls, 1);
    await feed.close();
    await assert.rejects(feed.listUsage(), (error: unknown) => error instanceof AgentFeedError);
    assert.equal(client.usageCalls, 1, "no request after close");
  });

  it("counts every (re)connect in connectionEpoch, so usage answers can be tied to one", async () => {
    const { client, scheduler, feed } = setup();
    await feed.start();
    scheduler.tick();
    const first = feed.connectionEpoch;
    assert.ok(first >= 1);
    scheduler.tick();
    assert.equal(feed.connectionEpoch, first, "staying connected changes nothing");
    await reconnect(client, scheduler);
    assert.equal(feed.connectionEpoch, first + 1);
  });
});

describe("AgentFeed.connectionEpoch on a reconnect the link poll missed", () => {
  for (const order of ["agents first", "workspaces first"] as const) {
    it(`bumps once per resync round (${order})`, async () => {
      const { client, scheduler, feed } = setup();
      await feed.start();
      scheduler.tick();
      const before = feed.connectionEpoch;
      const agents = () => {
        client.emitSnapshot(client.initialSnapshot);
      };
      const workspaces = () => {
        client.workspaces.emitSnapshot(client.workspaces.initialSnapshot);
      };
      const [first, second] =
        order === "agents first" ? [agents, workspaces] : [workspaces, agents];
      first();
      assert.equal(feed.connectionEpoch, before + 1, "the missed reconnect is a new connection");
      assert.equal(feed.stale, true);
      second();
      assert.equal(feed.connectionEpoch, before + 1, "the other directory's snapshot: same round");
      await flush();
      assert.equal(feed.stale, false);
      assert.equal(feed.connectionEpoch, before + 1);
    });
  }
});

/** Used % of the first usage entry the poller currently reports. */
function shownUsedPct(poller: UsagePoller): number | null {
  const entry = poller.state.snapshot?.entries[0];
  return entry?.kind === "window" ? entry.usedPct : null;
}

describe("AgentFeed with UsagePoller", () => {
  it("discards usage asked on the old connection after a missed reconnect and asks anew", async () => {
    const { client, scheduler, feed } = setup();
    await feed.start();
    scheduler.tick();
    const clock = new ManualScheduler();
    const poller = new UsagePoller({
      timers: clock,
      source: () => ({
        owner: feed,
        connectionEpoch: feed.connectionEpoch,
        serverId: feed.serverId,
        connected: feed.linkState.kind === "connected",
        settled: feed.ready && !feed.stale,
        listUsage: () => feed.listUsage(),
      }),
      onChange: () => undefined,
    });
    const old = deferred<unknown>();
    client.usageAnswers.push(old.promise);
    poller.setActive(true);
    assert.equal(client.usageCalls, 1);

    // The link poll never saw the drop; the resync snapshots reveal it.
    client.emitSnapshot(client.initialSnapshot);
    poller.sync();
    assert.equal(poller.state.pending, false, "the old request is abandoned");
    assert.equal(client.usageCalls, 1, "no request while the host is not confirmed");
    client.workspaces.emitSnapshot(client.workspaces.initialSnapshot);
    await flush();
    assert.equal(feed.stale, false);
    const fresh = deferred<unknown>();
    client.usageAnswers.push(fresh.promise);
    poller.sync();
    assert.equal(client.usageCalls, 2, "the new connection is asked once settled");

    const usage = (usedPct: number) => ({
      providers: [
        {
          providerId: "claude",
          displayName: "Claude",
          status: "available",
          windows: [{ id: "5h", label: "5h", usedPct }],
        },
      ],
    });
    old.resolve(usage(90));
    await flush();
    assert.equal(shownUsedPct(poller), null, "the old connection's answer is ignored");
    fresh.resolve(usage(10));
    await flush();
    assert.equal(shownUsedPct(poller), 10);
    assert.equal(poller.state.outdated, false);
    poller.dispose();
  });
});
