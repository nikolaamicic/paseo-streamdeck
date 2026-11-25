import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentFeed } from "../../src/paseo/agent-feed.ts";
import type { FeedWarning } from "../../src/paseo/feed-diagnostics.ts";
import { deferred, FakeClient, ManualScheduler } from "../support/fake-client.ts";
import { SERVER_ID } from "../support/fixtures.ts";
import { snapshot, workspacePayload } from "../support/paseo-payloads.ts";

/**
 * The feed's project list (P1) over FakeClient: started after the first
 * directory snapshots, never failing the feed, following a host change and
 * released on close. One explicit signal (until) per wait. Synthetic names.
 */

const projectList = (generation: string, ...projects: [string, string][]) => ({
  requestId: "r",
  projects: projects.map(([projectId, name]) => ({
    projectId,
    projectDisplayName: name,
    projectRootPath: "/tmp/synthetic",
    projectKind: "git",
  })),
  sync: { generation, headSeq: 0, mode: "snapshot", removals: [] },
});

function setup() {
  const client = new FakeClient();
  client.workspaces.initialSnapshot = snapshot([
    workspacePayload({ id: "a1", projectId: "p-alpha", projectDisplayName: "Project Alpha" }),
  ]);
  const warnings: FeedWarning[] = [];
  const waiters: { ready: () => boolean; resolve: () => void }[] = [];
  const check = () => {
    for (const waiter of waiters.splice(0)) {
      if (waiter.ready()) waiter.resolve();
      else waiters.push(waiter);
    }
  };
  let projectChanges = 0;
  const feed = new AgentFeed(
    client,
    {
      onProjectsChange: () => {
        projectChanges += 1;
        check();
      },
      onWarning: (warning) => warnings.push(warning),
    },
    { scheduler: new ManualScheduler() },
  );
  const until = (ready: () => boolean): Promise<void> => {
    if (ready()) return Promise.resolve();
    const seen = deferred<undefined>();
    waiters.push({
      ready,
      resolve: () => {
        seen.resolve(undefined);
      },
    });
    return seen.promise.then(() => undefined);
  };
  return { client, feed, warnings, until, projectChanges: () => projectChanges };
}

describe("AgentFeed projects (P1)", () => {
  it("starts after the first directory snapshots, subscribing to project.update and reading the list", async () => {
    const h = setup();
    h.client.projectListAnswers.push(
      Promise.resolve(
        projectList("g1", ["p-alpha", "Project Alpha"], ["p-gamma", "Project Gamma"]),
      ),
    );
    assert.equal(h.client.observeEventsCalls, 0);
    await h.feed.start();
    assert.deepEqual(h.client.observedEvents, [["project.update"]]);
    await h.until(() => h.feed.projects.status === "ready");
    assert.deepEqual(
      h.feed.projects.projects.map((project) => project.name).sort(),
      ["Project Alpha", "Project Gamma"],
      "the empty Gamma comes from the list",
    );
    // Workspaces carry the project link, but never create projects.
    assert.deepEqual(h.feed.workspaceList()[0]?.projectId, "p-alpha");
    await h.feed.close();
  });

  it("a project list or subscription failure never fails the feed", async () => {
    const h = setup();
    h.client.observeEventsError = new Error("raw");
    h.client.projectListAnswers.push(Promise.reject(new Error("raw list")));
    await h.feed.start();
    await h.until(() => h.feed.projects.status === "unavailable");
    assert.equal(h.feed.ready, true, "agents and workspaces are unaffected");
    assert.ok(h.warnings.some((warning) => warning.code === "project_subscription_failed"));
    assert.ok(h.warnings.some((warning) => warning.code === "project_list_failed"));
    assert.equal(JSON.stringify(h.warnings).includes("raw"), false);
    h.client.observeEventsError = null;
    assert.equal(h.feed.retryProjects(), true);
    await h.until(() => h.feed.projects.status === "ready");
    await h.feed.close();
  });

  it("a new host after a reconnect drops the old projects and reads the new host's list", async () => {
    const h = setup();
    h.client.projectListAnswers.push(
      Promise.resolve(projectList("g1", ["p-alpha", "Project Alpha"])),
    );
    await h.feed.start();
    await h.until(() => h.feed.projects.status === "ready");
    h.client.projectListAnswers.push(
      Promise.resolve(projectList("g7", ["p-other", "Other host project"])),
    );
    h.client.serverId = "srv_OtherDaemon";
    h.client.workspaces.emitSnapshot(
      snapshot([workspacePayload({ id: "w9", projectId: "p-other" })]),
    );
    await h.until(
      () =>
        h.feed.projects.status === "ready" &&
        h.feed.projects.projects[0]?.address.serverId === "srv_OtherDaemon",
    );
    assert.deepEqual(
      h.feed.projects.projects.map((project) => project.address.projectId),
      ["p-other"],
    );
    assert.equal(
      h.feed.projects.projects.some((project) => project.address.serverId === SERVER_ID),
      false,
    );
    await h.feed.close();
  });

  it("close releases the project subscription; a failing release shows in the close outcome", async () => {
    const h = setup();
    await h.feed.start();
    await h.until(() => h.feed.projects.status === "ready");
    assert.deepEqual(await h.feed.close(), { subscriptions: "released", client: "closed" });
    assert.equal(h.client.projectEvents.released, 1);
    assert.equal(h.feed.retryProjects(), false);

    const failing = setup();
    failing.client.projectEvents.releaseError = new Error("raw release");
    await failing.feed.start();
    assert.deepEqual(await failing.feed.close(), { subscriptions: "failed", client: "closed" });
  });

  it("an earlier failed project release still shows in the feed's close outcome", async () => {
    const h = setup();
    await h.feed.start();
    await h.until(() => h.feed.projects.status === "ready");
    h.client.projectEvents.releaseError = new Error("raw release");
    h.client.projectEvents.fail();
    await h.until(() => h.feed.projects.status === "not_live");
    h.client.projectEvents.releaseError = null;
    assert.deepEqual(await h.feed.close(), { subscriptions: "failed", client: "closed" });
  });
});

describe("AgentFeed projects with a daemon-faithful list (C6 finding)", () => {
  it("asks for the sync position and becomes current; without asking Paseo sends none", async () => {
    const h = setup();
    h.client.listedProjects = [
      {
        projectId: "p-alpha",
        projectDisplayName: "Project Alpha",
        projectRootPath: "/tmp/synthetic",
        projectKind: "git",
      },
    ];
    await h.feed.start();
    await h.until(() => h.feed.projects.status === "ready");
    assert.deepEqual(h.client.projectListRequests, [{ sync: {} }]);
    assert.equal(h.feed.projects.current, true);
    assert.equal(
      h.warnings.some((warning) => warning.code === "project_sync_missing"),
      false,
    );
    // The fake answers as the daemon does: a request without `sync` gets no position.
    const unasked: unknown = await h.client.projects.list();
    assert.equal(typeof unasked === "object" && unasked !== null && "sync" in unasked, false);
    await h.feed.close();
  });
});
