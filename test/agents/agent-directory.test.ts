import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentDirectory } from "../../src/agents/agent-directory.ts";
import { agentKey, type AgentRecord } from "../../src/agents/agent-model.ts";
import { makeRecord, SERVER_ID } from "../support/fixtures.ts";

function key(agentId: string): string {
  return agentKey({ serverId: SERVER_ID, agentId });
}

function kinds(changes: readonly { kind: string; key: string }[]): [string, string][] {
  return changes.map((change) => [change.kind, change.key]);
}

describe("AgentDirectory snapshots", () => {
  it("reports every agent of the first snapshot as added", () => {
    const directory = new AgentDirectory();
    const changes = directory.replaceAll([
      makeRecord({ agentId: "a" }),
      makeRecord({ agentId: "b" }),
    ]);
    assert.deepEqual(kinds(changes), [
      ["added", key("a")],
      ["added", key("b")],
    ]);
    assert.equal(directory.size, 2);
  });

  it("reconciles a later snapshot: removes missing, updates changed, adds new", () => {
    const directory = new AgentDirectory();
    directory.replaceAll([
      makeRecord({ agentId: "a" }),
      makeRecord({ agentId: "b" }),
      makeRecord({ agentId: "c" }),
    ]);
    const changes = directory.replaceAll([
      makeRecord({ agentId: "a" }),
      makeRecord({ agentId: "b", status: "running", rawStatus: "running" }),
      makeRecord({ agentId: "d" }),
    ]);
    assert.deepEqual(kinds(changes), [
      ["removed", key("c")],
      ["updated", key("b")],
      ["added", key("d")],
    ]);
    assert.deepEqual(
      directory.list().map((record) => record.address.agentId),
      ["a", "b", "d"],
    );
  });

  it("reports nothing when an identical snapshot arrives again", () => {
    const directory = new AgentDirectory();
    directory.replaceAll([makeRecord({ agentId: "a" }), makeRecord({ agentId: "b" })]);
    assert.deepEqual(
      directory.replaceAll([makeRecord({ agentId: "a" }), makeRecord({ agentId: "b" })]),
      [],
    );
  });

  it("removes everything for an empty snapshot", () => {
    const directory = new AgentDirectory();
    directory.replaceAll([makeRecord()]);
    assert.deepEqual(kinds(directory.replaceAll([])), [["removed", key("agent-1")]]);
    assert.equal(directory.size, 0);
  });

  it("keeps the later entry when a snapshot repeats an identity", () => {
    const directory = new AgentDirectory();
    const changes = directory.replaceAll([
      makeRecord({ title: "first" }),
      makeRecord({ title: "second" }),
    ]);
    assert.equal(changes.length, 1);
    assert.equal(directory.get(makeRecord().address)?.title, "second");
  });
});

describe("AgentDirectory updates", () => {
  it("ignores an upsert that changes nothing", () => {
    const directory = new AgentDirectory();
    directory.replaceAll([makeRecord()]);
    assert.equal(directory.upsert(makeRecord()), null);
  });

  it("reports a status change as an update of the same identity", () => {
    const directory = new AgentDirectory();
    directory.replaceAll([makeRecord()]);
    const change = directory.upsert(makeRecord({ status: "running", rawStatus: "running" }));
    assert.ok(change?.kind === "updated");
    assert.equal(change.previous.status, "idle");
    assert.equal(change.record.status, "running");
    assert.equal(directory.get(makeRecord().address)?.status, "running");
  });

  it("reports a move to another workspace as an update, even with the same project", () => {
    const directory = new AgentDirectory();
    directory.replaceAll([makeRecord()]);
    const change = directory.upsert(makeRecord({ workspaceId: "workspace-2" }), {
      preserveProject: true,
    });
    assert.ok(change?.kind === "updated");
    assert.equal(change.previous.workspaceId, "workspace-1");
    assert.equal(change.record.workspaceId, "workspace-2");
    assert.deepEqual(change.record.project, change.previous.project);
  });

  it("adds an unknown agent on upsert", () => {
    const directory = new AgentDirectory();
    assert.equal(directory.upsert(makeRecord({ agentId: "new" }))?.kind, "added");
    assert.equal(directory.size, 1);
  });

  it("keeps the known project when an upsert omits its placement", () => {
    const directory = new AgentDirectory();
    directory.replaceAll([makeRecord()]);
    const change = directory.upsert(makeRecord({ project: null, status: "running" }), {
      preserveProject: true,
    });
    assert.equal(change?.kind, "updated");
    assert.equal(directory.get(makeRecord().address)?.project?.name, "Test project");
  });

  it("clears the project when an update explicitly reports none", () => {
    const directory = new AgentDirectory();
    directory.replaceAll([makeRecord()]);
    directory.upsert(makeRecord({ project: null }));
    assert.equal(directory.get(makeRecord().address)?.project, null);
  });

  it("removes a known agent once and ignores unknown removals", () => {
    const directory = new AgentDirectory();
    directory.replaceAll([makeRecord()]);
    assert.equal(directory.remove(makeRecord().address)?.kind, "removed");
    assert.equal(directory.remove(makeRecord().address), null);
    assert.equal(directory.remove({ serverId: SERVER_ID, agentId: "missing" }), null);
  });
});

describe("AgentDirectory identity", () => {
  it("never conflates agents that share a title", () => {
    const directory = new AgentDirectory();
    directory.replaceAll([
      makeRecord({ agentId: "a", title: "Same" }),
      makeRecord({ agentId: "b", title: "Same" }),
    ]);
    assert.equal(directory.size, 2);
  });

  it("keeps the same agent ID on different servers apart", () => {
    const directory = new AgentDirectory();
    const other: AgentRecord = {
      ...makeRecord(),
      address: { serverId: "srv_Other", agentId: "agent-1" },
    };
    directory.replaceAll([makeRecord(), other]);
    assert.equal(directory.size, 2);
    assert.equal(directory.remove(other.address)?.kind, "removed");
    assert.ok(directory.get(makeRecord().address));
  });
});

describe("AgentDirectory reference safety", () => {
  it("is not affected by later edits of the inserted object", () => {
    const directory = new AgentDirectory();
    const input = { ...makeRecord(), title: "original" };
    directory.replaceAll([input]);
    input.title = "edited";
    assert.equal(directory.get(makeRecord().address)?.title, "original");
  });

  it("hands out frozen records and a fresh list", () => {
    const directory = new AgentDirectory();
    directory.replaceAll([makeRecord()]);
    const record = directory.get(makeRecord().address);
    assert.ok(record);
    assert.equal(Reflect.set(record, "title", "mutated"), false);
    assert.equal(Reflect.set(record.address, "agentId", "other"), false);
    assert.equal(directory.get(makeRecord().address)?.title, "Test agent");

    const list = directory.list();
    list.pop();
    assert.equal(directory.size, 1);
    assert.equal(directory.list().length, 1);
  });

  it("reports frozen records in changes", () => {
    const directory = new AgentDirectory();
    const [change] = directory.replaceAll([makeRecord()]);
    assert.ok(change?.kind === "added");
    assert.equal(Object.isFrozen(change.record), true);
  });
});
