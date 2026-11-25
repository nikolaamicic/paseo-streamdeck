import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceChange } from "../../src/workspaces/workspace-directory.ts";
import {
  AgentFeed,
  AgentFeedError,
  RESYNC_HOST_TIMEOUT_MS,
  type AgentFeedListener,
  type FeedWarning,
} from "../../src/paseo/agent-feed.ts";
import { FeedRecovery } from "../../src/paseo/feed-recovery.ts";
import { slotKeyView } from "../../src/spike/key-view.ts";
import { deferred, FakeClient, flush, ManualScheduler } from "../support/fake-client.ts";
import {
  agentPayload,
  entry,
  SERVER_ID,
  snapshot,
  workspacePayload,
} from "../support/paseo-payloads.ts";

function setup() {
  const client = new FakeClient();
  client.initialSnapshot = snapshot([entry({ id: "a" })]);
  client.workspaces.initialSnapshot = snapshot([
    workspacePayload({ id: "w1", name: "main" }),
    workspacePayload({ id: "w2", name: "feature" }),
  ]);
  const scheduler = new ManualScheduler();
  const recorded: {
    workspaceChanges: WorkspaceChange[];
    workspaceSnapshots: WorkspaceChange[][];
    warnings: FeedWarning[];
    failures: string[];
  } = { workspaceChanges: [], workspaceSnapshots: [], warnings: [], failures: [] };
  const listener: AgentFeedListener = {
    onWorkspaceChange: (change) => recorded.workspaceChanges.push(change),
    onWorkspaceSnapshot: (changes) => recorded.workspaceSnapshots.push([...changes]),
    onWarning: (warning) => recorded.warnings.push(warning),
    onFailure: (error) => recorded.failures.push(error.code),
  };
  const feed = new AgentFeed(client, listener, { scheduler });
  return { client, scheduler, recorded, feed };
}

const workspaceIds = (feed: AgentFeed): string[] =>
  feed.workspaceList().map((workspace) => workspace.address.workspaceId);

async function pollReconnect(client: FakeClient, scheduler: ManualScheduler): Promise<void> {
  client.state = { status: "disconnected", reason: "Transport closed" };
  scheduler.tick();
  client.state = { status: "connected" };
  scheduler.tick();
  await flush();
}

describe("AgentFeed workspace subscription: start", () => {
  it("subscribes to both directories once and resolves after both first snapshots", async () => {
    const { client, feed } = setup();
    await feed.start();
    assert.deepEqual(client.workspaces.listCalls, [{ subscribe: {}, page: { limit: 200 } }]);
    assert.equal(client.listCalls.length, 1);
    assert.deepEqual(workspaceIds(feed), ["w1", "w2"]);
    assert.equal(feed.workspaces.get({ serverId: SERVER_ID, workspaceId: "w1" })?.name, "main");
    assert.equal(feed.workspaceSnapshotsApplied, 1);
    assert.equal(feed.stale, false);
    await feed.close();
  });

  it("never presents partial first data as fresh or ready, in either order", async () => {
    for (const late of ["workspaces", "agents"] as const) {
      const { client, feed } = setup();
      if (late === "workspaces") client.workspaces.deliverInitialSnapshot = false;
      else client.deliverInitialSnapshot = false;
      const starting = feed.start();
      await flush();
      assert.equal(feed.ready, false, late);
      assert.equal(feed.stale, true, `${late} missing: the other directory's data is partial`);
      // What the plugin draws from the same feed state: no agent yet.
      const view = slotKeyView({
        connection: "ok",
        slot: { serverId: SERVER_ID, agentId: "a" },
        dimmed: false,
        link: feed.linkState.kind,
        stale: feed.stale,
        failure: feed.failure,
        recoveryError: null,
        retryAvailable: false,
        serverId: feed.serverId,
        hasSnapshot: feed.ready,
        record: feed.directory.get({ serverId: SERVER_ID, agentId: "a" }),
      });
      assert.equal(view.identity, null, late);
      assert.equal(view.face.kind, "message", late);

      if (late === "workspaces") client.workspaces.emitSnapshot(snapshot([workspacePayload()]));
      else client.emitSnapshot(snapshot([entry({ id: "a" })]));
      await starting;
      assert.equal(feed.ready, true, late);
      assert.equal(feed.stale, false, late);
      await feed.close();
    }
  });

  it("does not list the workspace directory when close() ran during the agent list", async () => {
    const { client, feed } = setup();
    const gate = deferred<undefined>();
    client.listGate = gate.promise;
    const starting = feed.start();
    await flush();
    await feed.close();
    gate.resolve(undefined);
    await assert.rejects(starting, (error: unknown) => {
      return error instanceof AgentFeedError && error.code === "closed";
    });
    assert.equal(client.workspaces.listCalls.length, 0);
    assert.equal(client.released, 1, "the late agent subscription is released");
    assert.equal(client.observers.size, 0);
  });

  it("attempts every cleanup step when unsubscribing throws, without leaking the error", async () => {
    const SENTINEL = "synthetic cleanup sentinel";
    const { client, feed } = setup();
    await feed.start();
    client.unsubscribeError = new Error(SENTINEL);
    client.workspaces.unsubscribeError = new Error(SENTINEL);
    // C3b1: the outcome reports the failed unsubscribe, without its error.
    const outcome = await feed.close();
    assert.deepEqual(outcome, { subscriptions: "failed", client: "closed" });
    assert.doesNotMatch(JSON.stringify(outcome), /sentinel/);
    assert.equal(client.released, 1);
    assert.equal(client.workspaces.released, 1);
    assert.equal(client.closed, 1);
    assert.equal(client.observers.size + client.workspaces.observers.size, 0);
  });

  it("passes the background option to both directories", async () => {
    const client = new FakeClient();
    const feed = new AgentFeed(
      client,
      {},
      { scheduler: new ManualScheduler(), includeBackground: true },
    );
    await feed.start();
    assert.deepEqual(client.workspaces.listCalls, [
      { subscribe: {}, page: { limit: 200 }, includeBackground: true },
    ]);
    await feed.close();
  });

  it("does not resolve before the first workspace snapshot", async () => {
    const { client, feed } = setup();
    client.workspaces.deliverInitialSnapshot = false;
    let started = false;
    const starting = feed.start().then(() => {
      started = true;
    });
    await flush();
    assert.equal(feed.snapshotsApplied, 1, "the agent snapshot is already applied");
    assert.equal(started, false);
    client.workspaces.emitSnapshot(snapshot([workspacePayload({ id: "w9" })]));
    await starting;
    assert.deepEqual(workspaceIds(feed), ["w9"]);
    await feed.close();
  });

  it("fails start terminally on a malformed first workspace snapshot and releases both", async () => {
    const { client, scheduler, feed, recorded } = setup();
    client.workspaces.initialSnapshot = { items: [] };
    await assert.rejects(feed.start(), (error: unknown) => {
      return error instanceof AgentFeedError && error.code === "initial_snapshot_invalid";
    });
    assert.deepEqual(recorded.failures, ["initial_snapshot_invalid"]);
    assert.ok(recorded.warnings.some((warning) => warning.code === "workspace_snapshot_invalid"));
    await feed.close();
    assert.equal(client.released, 1);
    assert.equal(client.workspaces.released, 1);
    assert.equal(client.observers.size + client.workspaces.observers.size, 0);
    assert.equal(client.closed, 1);
    assert.equal(scheduler.active, 0);
  });

  it("rejects when the workspace subscription fails and close releases the agent one", async () => {
    for (const how of ["list", "subscribe"] as const) {
      const { client, feed } = setup();
      if (how === "list") client.workspaces.listError = new Error("raw list failure");
      else client.workspaces.subscribeError = new Error("raw subscribe failure");
      await assert.rejects(feed.start(), (error: unknown) => {
        return (
          error instanceof AgentFeedError &&
          error.code === "subscribe_failed" &&
          !error.message.includes("raw")
        );
      });
      await feed.close();
      assert.equal(client.released, 1, how);
      assert.equal(client.workspaces.released, how === "list" ? 0 : 1, how);
      assert.equal(client.observers.size + client.workspaces.observers.size, 0, how);
      assert.equal(client.closed, 1, how);
    }
  });

  it("releases a workspace subscription that arrives after close()", async () => {
    const { client, feed } = setup();
    const gate = deferred<undefined>();
    client.workspaces.listGate = gate.promise;
    const starting = feed.start();
    await flush();
    await feed.close();
    gate.resolve(undefined);
    await assert.rejects(starting, (error: unknown) => {
      return error instanceof AgentFeedError && error.code === "closed";
    });
    assert.equal(client.released, 1);
    assert.equal(client.workspaces.released, 1, "the late subscription is released");
    assert.equal(client.workspaces.observers.size, 0, "and never observed");
  });
});

describe("AgentFeed workspace subscription: updates", () => {
  it("applies workspace upserts and removes independently of agents", async () => {
    const { client, feed, recorded } = setup();
    await feed.start();
    client.workspaces.emitUpdate({
      kind: "upsert",
      workspace: workspacePayload({ id: "w1", name: "renamed" }),
    });
    client.workspaces.emitUpdate({ kind: "remove", id: "w2" });
    client.emitUpdate({ kind: "upsert", agent: agentPayload({ id: "a", status: "running" }) });
    await flush();
    assert.deepEqual(
      recorded.workspaceChanges.map((change) => change.kind),
      ["updated", "removed"],
    );
    assert.deepEqual(workspaceIds(feed), ["w1"]);
    assert.equal(feed.directory.get({ serverId: SERVER_ID, agentId: "a" })?.status, "running");
    assert.equal(feed.directory.size, 1, "workspace updates never touch agents");
    await feed.close();
  });

  it("ignores invalid workspace updates with a stable code, and updates of the other kind", async () => {
    const { client, feed, recorded } = setup();
    await feed.start();
    client.workspaces.emitUpdate({ kind: "remove", id: "\uD800" });
    for (const observer of client.observers) {
      observer.update({ type: "workspace_update", payload: { kind: "remove", id: "w1" } });
    }
    await flush();
    const ignored = recorded.warnings.find(
      (warning) => warning.code === "workspace_update_ignored",
    );
    assert.equal(ignored?.detail, "invalid_workspace_id");
    assert.doesNotMatch(JSON.stringify(recorded.warnings), /\\uD800|\uD800/);
    assert.deepEqual(
      workspaceIds(feed),
      ["w1", "w2"],
      "a workspace update on the agent stream is ignored",
    );
    await feed.close();
  });

  it("skips invalid entries of a workspace snapshot and keeps the rest", async () => {
    const { client, feed, recorded } = setup();
    client.workspaces.initialSnapshot = snapshot([
      workspacePayload({ id: "w1" }),
      workspacePayload({ id: "" }),
      workspacePayload({ id: "w3", status: undefined }),
    ]);
    await feed.start();
    assert.deepEqual(workspaceIds(feed), ["w1"]);
    assert.deepEqual(
      recorded.warnings
        .filter((warning) => warning.code === "workspace_entry_skipped")
        .map((warning) => warning.detail),
      ["missing_workspace_id", "missing_workspace_status"],
    );
    await feed.close();
  });

  it("reports truncation per directory", async () => {
    const { client, feed, recorded } = setup();
    client.workspaces.initialSnapshot = snapshot([workspacePayload()], true);
    await feed.start();
    assert.equal(feed.workspacesTruncated, true);
    assert.equal(feed.truncated, false);
    assert.ok(recorded.warnings.some((warning) => warning.code === "workspace_page_truncated"));
    assert.equal(
      recorded.warnings.some((warning) => warning.code === "page_truncated"),
      false,
    );
    await feed.close();
  });
});

describe("AgentFeed workspace subscription: freshness and reconnect", () => {
  it("stays stale after a reconnect until both directories applied their snapshot, in any order", async () => {
    for (const order of ["agents first", "workspaces first"] as const) {
      const { client, scheduler, feed } = setup();
      await feed.start();
      await pollReconnect(client, scheduler);
      assert.equal(feed.stale, true, order);
      const agents = (): void => {
        client.emitSnapshot(snapshot([entry({ id: "a" })]));
      };
      const workspaces = (): void => {
        client.workspaces.emitSnapshot(snapshot([workspacePayload({ id: "w1" })]));
      };
      (order === "agents first" ? agents : workspaces)();
      await flush();
      assert.equal(feed.stale, true, `${order}: one directory is still from before`);
      (order === "agents first" ? workspaces : agents)();
      await flush();
      assert.equal(feed.stale, false, order);
      assert.deepEqual(workspaceIds(feed), ["w1"]);
      await feed.close();
    }
  });

  it("treats a second workspace snapshot as a reconnect the poll missed", async () => {
    const { client, feed } = setup();
    await feed.start();
    client.workspaces.emitSnapshot(snapshot([workspacePayload({ id: "w1" })]));
    await flush();
    assert.equal(feed.linkState.kind, "connected");
    assert.equal(feed.stale, true, "the agent directory must be refreshed too");
    client.emitSnapshot(snapshot([entry({ id: "a" })]));
    await flush();
    assert.equal(feed.stale, false);
  });

  it("keeps the previous workspaces stale after a malformed resync, without failing", async () => {
    const { client, scheduler, feed, recorded } = setup();
    await feed.start();
    await pollReconnect(client, scheduler);
    client.emitSnapshot(snapshot([entry({ id: "a" })]));
    client.workspaces.emitSnapshot({ items: [] });
    await flush();
    assert.equal(feed.failure, null);
    assert.equal(feed.stale, true);
    assert.deepEqual(workspaceIds(feed), ["w1", "w2"]);
    assert.ok(recorded.warnings.some((warning) => warning.code === "workspace_snapshot_invalid"));
    await feed.close();
  });

  it("bounds a hanging host lookup for a workspace resync without blocking agent updates", async () => {
    const { client, scheduler, feed, recorded } = setup();
    await feed.start();
    const hanging = deferred<undefined>();
    client.hostsListGates = [hanging.promise];
    client.workspaces.emitSnapshot(snapshot([workspacePayload({ id: "w1" })]));
    client.emitUpdate({ kind: "upsert", agent: agentPayload({ id: "a", status: "running" }) });
    await flush();
    assert.equal(feed.directory.get({ serverId: SERVER_ID, agentId: "a" })?.status, "idle");
    scheduler.advance(RESYNC_HOST_TIMEOUT_MS);
    await flush();
    assert.ok(recorded.warnings.some((warning) => warning.code === "resync_failed"));
    assert.equal(feed.directory.get({ serverId: SERVER_ID, agentId: "a" })?.status, "running");
    assert.deepEqual(workspaceIds(feed), ["w1", "w2"], "the previous workspaces are kept");
    assert.equal(feed.stale, true);
    hanging.resolve(undefined);
    await flush();
    assert.equal(feed.workspaceSnapshotsApplied, 1, "the late identity is ignored");
    await feed.close();
  });

  it("never mixes hosts: a new host clears the other directory until its own snapshot", async () => {
    for (const first of ["agents", "workspaces"] as const) {
      const { client, scheduler, feed, recorded } = setup();
      await feed.start();
      await pollReconnect(client, scheduler);
      client.serverId = "srv_OtherDaemon";
      if (first === "agents") client.emitSnapshot(snapshot([entry({ id: "a" })]));
      else client.workspaces.emitSnapshot(snapshot([workspacePayload({ id: "w1" })]));
      await flush();
      assert.equal(feed.serverId, "srv_OtherDaemon", first);
      assert.equal(feed.stale, true, first);
      const other =
        first === "agents"
          ? feed.workspaceList().map((workspace) => workspace.address.serverId)
          : feed.agents().map((agent) => agent.address.serverId);
      assert.deepEqual(other, [], `${first}: the other directory holds no old-host data`);
      assert.ok(recorded.warnings.some((warning) => warning.code === "server_changed"));

      if (first === "agents")
        client.workspaces.emitSnapshot(snapshot([workspacePayload({ id: "w1" })]));
      else client.emitSnapshot(snapshot([entry({ id: "a" })]));
      await flush();
      assert.equal(feed.stale, false, first);
      const servers = new Set([
        ...feed.agents().map((agent) => agent.address.serverId),
        ...feed.workspaceList().map((workspace) => workspace.address.serverId),
      ]);
      assert.deepEqual([...servers], ["srv_OtherDaemon"], first);
      await feed.close();
    }
  });

  it("hands a failure of both subscriptions to the K2 owner exactly once", async () => {
    const scheduler = new ManualScheduler();
    const clients: FakeClient[] = [];
    const recovery = new FeedRecovery<AgentFeed>({
      createFeed: (onTerminalFailure) => {
        const client = new FakeClient();
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
    const first = clients[0];
    assert.ok(first);
    first.workspaces.emitError(new Error("raw"));
    first.emitError(new Error("raw"));
    await flush();
    assert.deepEqual(recovery.state, { kind: "waiting", error: "subscription_failed" });
    assert.equal(scheduler.pendingTimers, 1, "one retry, no second loop");
    assert.equal(first.closed, 1);
    assert.equal(first.released + first.workspaces.released, 2);
    await recovery.stop();
  });

  it("fails once when either subscription fails, and ignores later events", async () => {
    const { client, feed, recorded } = setup();
    await feed.start();
    client.workspaces.emitError(new Error("raw"));
    client.emitError(new Error("raw"));
    client.workspaces.emitUpdate({ kind: "remove", id: "w1" });
    await flush();
    assert.deepEqual(recorded.failures, ["subscription_failed"]);
    assert.equal(feed.failure, "subscription_failed");
    assert.equal(feed.stale, true);
    assert.deepEqual(workspaceIds(feed), ["w1", "w2"]);
    await feed.close();
    assert.equal(client.released + client.workspaces.released, 2);
  });
});
