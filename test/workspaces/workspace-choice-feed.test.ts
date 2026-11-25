import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentFeed } from "../../src/paseo/agent-feed.ts";
import {
  ALL_PROJECTS,
  choiceSourceOf,
  ProjectChoice,
  selectProject,
  type ChoiceSource,
  type ProjectSelection,
} from "../../src/workspaces/project-selection.ts";
import { readStartIn, type StartIn } from "../../src/workspaces/start-in-settings.ts";
import { FakeClient, flush, ManualScheduler } from "../support/fake-client.ts";
import { entry, SERVER_ID, snapshot, workspacePayload } from "../support/paseo-payloads.ts";

const HOST_B = "srv_HostB";
/**
 * ProjectChoice over the concrete AgentFeed (P2): a version 1 workspace
 * Start in resolves to that workspace's project only from the new host's
 * fresh data. Adapted from the workspace choice tests (intended semantics).
 */
const label = (selection: ProjectSelection | null): string => {
  if (selection === null) return "Loading";
  if (selection.kind === "project") return selection.address.projectId;
  return selection.kind === "all" ? "All" : `unresolved:${selection.reason}`;
};
const legacy = (serverId: string, workspaceId: string): StartIn =>
  readStartIn({ version: 1, startIn: { serverId, workspaceId } }).startIn;
const source = (feed: AgentFeed): ChoiceSource =>
  choiceSourceOf({
    ready: feed.ready,
    stale: feed.stale,
    serverId: feed.serverId,
    workspaces: feed.workspaceList(),
    truncated: feed.workspacesTruncated,
  });

async function startedFeed() {
  const client = new FakeClient();
  client.initialSnapshot = snapshot([entry({ id: "a" })]);
  client.workspaces.initialSnapshot = snapshot([workspacePayload({ id: "w1" })]);
  const scheduler = new ManualScheduler();
  const feed = new AgentFeed(client, {}, { scheduler });
  await feed.start();
  return { client, scheduler, feed };
}

async function disconnect(client: FakeClient, scheduler: ManualScheduler): Promise<void> {
  client.state = { status: "disconnected", reason: "Transport closed" };
  scheduler.tick();
  client.state = { status: "connected" };
  scheduler.tick();
  await flush();
}

describe("ProjectChoice with the concrete AgentFeed", () => {
  it("resolves the new host's saved workspace to its project only after both snapshots, in either order", async () => {
    for (const first of ["agents", "workspaces"] as const) {
      const { client, scheduler, feed } = await startedFeed();
      const choice = new ProjectChoice(legacy(HOST_B, "w1"));
      choice.sync(source(feed));
      assert.equal(
        label(choice.selection),
        "unresolved:other_host",
        `${first}: Start in names another host, shown as such, never All`,
      );

      await disconnect(client, scheduler);
      client.serverId = HOST_B;
      const agents = (): void => {
        client.emitSnapshot(snapshot([entry({ id: "a" })]));
      };
      const workspaces = (): void => {
        client.workspaces.emitSnapshot(snapshot([workspacePayload({ id: "w1" })]));
      };
      (first === "agents" ? agents : workspaces)();
      await flush();
      assert.equal(feed.serverId, HOST_B, first);
      assert.equal(feed.ready, true, `${first}: ready is cumulative`);
      choice.sync(source(feed));
      assert.equal(label(choice.selection), "Loading", `${first}: no old-host choice shown`);
      assert.equal(choice.choose(ALL_PROJECTS), false, `${first}: no choice while resolving`);

      (first === "agents" ? workspaces : agents)();
      await flush();
      choice.sync(source(feed));
      assert.deepEqual(
        choice.selection,
        selectProject({ serverId: HOST_B, projectId: "project-1" }),
        first,
      );
      await feed.close();
    }
  });

  it("keeps the user's choice through an ordinary reconnect to the same host", async () => {
    const { client, scheduler, feed } = await startedFeed();
    const choice = new ProjectChoice(readStartIn({}).startIn);
    choice.sync(source(feed));
    assert.equal(
      choice.choose(selectProject({ serverId: SERVER_ID, projectId: "project-1" })),
      true,
    );

    await disconnect(client, scheduler);
    assert.equal(feed.stale, true);
    assert.equal(choice.sync(source(feed)), false);
    client.emitSnapshot(snapshot([entry({ id: "a" })]));
    client.workspaces.emitSnapshot(snapshot([workspacePayload({ id: "w1" })]));
    await flush();
    assert.equal(choice.sync(source(feed)), false);
    assert.equal(label(choice.selection), "project-1");
    await feed.close();
  });

  it("waits for fresh data before the first resolution", () => {
    const choice = new ProjectChoice(legacy(SERVER_ID, "w1"));
    const stale = choiceSourceOf({
      ready: true,
      stale: true,
      serverId: SERVER_ID,
      workspaces: [],
      truncated: false,
    });
    assert.equal(choice.sync(stale), false);
    assert.equal(choice.selection, null);
  });

  it("is not affected by later edits of the Start in object", async () => {
    const { feed } = await startedFeed();
    const startIn = { serverId: SERVER_ID, workspaceId: "w1" };
    const choice = new ProjectChoice(readStartIn({ version: 1, startIn }).startIn);
    startIn.workspaceId = "changed";
    choice.sync(source(feed));
    assert.equal(label(choice.selection), "project-1");
    await feed.close();
  });
});
