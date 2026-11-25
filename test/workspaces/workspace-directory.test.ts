import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkspaceDirectory } from "../../src/workspaces/workspace-directory.ts";
import {
  freezeWorkspace,
  workspaceKey,
  workspacesEqual,
  type WorkspaceRecord,
} from "../../src/workspaces/workspace-model.ts";
import { makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

function kinds(changes: readonly { kind: string; key: string }[]): [string, string][] {
  return changes.map((change) => [change.kind, change.key]);
}

function key(workspaceId: string, serverId = SERVER_ID): string {
  return workspaceKey({ serverId, workspaceId });
}

describe("workspace identity", () => {
  it("is qualified by the server and cannot collide through the separator", () => {
    assert.notEqual(key("w", "srv_A"), key("w", "srv_B"));
    assert.notEqual(key("c", "a/b"), key("b/c", "a"));
  });
});

describe("workspacesEqual", () => {
  it("considers an identical copy equal", () => {
    assert.equal(workspacesEqual(makeWorkspace(), makeWorkspace()), true);
  });

  const changes: [string, Partial<WorkspaceRecord>][] = [
    ["name", { name: "feature-x" }],
    ["project name", { projectName: "Other project" }],
    ["raw status", { rawStatus: "paused", status: "unknown" }],
    ["status", { rawStatus: "running", status: "running" }],
    ["archiving", { archiving: true }],
  ];
  for (const [field, change] of changes) {
    it(`detects a change of ${field}`, () => {
      assert.equal(workspacesEqual(makeWorkspace(), makeWorkspace(change)), false);
    });
  }

  it("detects a different identity", () => {
    assert.equal(
      workspacesEqual(makeWorkspace({ workspaceId: "a" }), makeWorkspace({ workspaceId: "b" })),
      false,
    );
  });
});

describe("freezeWorkspace", () => {
  it("returns a frozen copy detached from later edits of the input", () => {
    const input = { ...makeWorkspace(), address: { serverId: SERVER_ID, workspaceId: "w" } };
    const frozen = freezeWorkspace(input);
    input.address.workspaceId = "changed";
    assert.equal(frozen.address.workspaceId, "w");
    assert.equal(Object.isFrozen(frozen), true);
    assert.equal(Object.isFrozen(frozen.address), true);
  });
});

describe("WorkspaceDirectory", () => {
  it("adds every workspace of the first snapshot and reconciles a later one", () => {
    const directory = new WorkspaceDirectory();
    const first = directory.replaceAll([
      makeWorkspace({ workspaceId: "a" }),
      makeWorkspace({ workspaceId: "b" }),
    ]);
    assert.deepEqual(kinds(first), [
      ["added", key("a")],
      ["added", key("b")],
    ]);
    const second = directory.replaceAll([
      makeWorkspace({ workspaceId: "b", rawStatus: "running", status: "running" }),
      makeWorkspace({ workspaceId: "c" }),
    ]);
    assert.deepEqual(kinds(second), [
      ["removed", key("a")],
      ["updated", key("b")],
      ["added", key("c")],
    ]);
    assert.equal(directory.size, 2);
  });

  it("reports nothing for an identical snapshot or an unchanged upsert", () => {
    const directory = new WorkspaceDirectory();
    directory.replaceAll([makeWorkspace()]);
    assert.deepEqual(directory.replaceAll([makeWorkspace()]), []);
    assert.equal(directory.upsert(makeWorkspace()), null);
  });

  it("reports a rename or archiving as an update of the same identity", () => {
    const directory = new WorkspaceDirectory();
    directory.replaceAll([makeWorkspace()]);
    const change = directory.upsert(makeWorkspace({ name: "renamed", archiving: true }));
    assert.ok(change?.kind === "updated");
    assert.equal(change.previous.name, "main");
    assert.equal(change.record.archiving, true);
  });

  it("keeps workspaces with the same name apart by identity", () => {
    const directory = new WorkspaceDirectory();
    directory.replaceAll([
      makeWorkspace({ workspaceId: "a", projectName: "One" }),
      makeWorkspace({ workspaceId: "b", projectName: "Two" }),
      makeWorkspace({ workspaceId: "c", projectName: "One" }),
    ]);
    assert.equal(directory.size, 3);
    assert.equal(directory.get({ serverId: SERVER_ID, workspaceId: "c" })?.projectName, "One");
  });

  it("keeps the same workspace ID on different servers apart", () => {
    const directory = new WorkspaceDirectory();
    directory.upsert(makeWorkspace({ serverId: "srv_A", name: "on A" }));
    directory.upsert(makeWorkspace({ serverId: "srv_B", name: "on B" }));
    assert.equal(directory.size, 2);
    assert.equal(directory.get({ serverId: "srv_A", workspaceId: "workspace-1" })?.name, "on A");
    assert.equal(
      directory.remove({ serverId: "srv_B", workspaceId: "workspace-1" })?.kind,
      "removed",
    );
    assert.equal(directory.get({ serverId: "srv_A", workspaceId: "workspace-1" })?.name, "on A");
  });

  it("removes a known workspace once and ignores unknown removals", () => {
    const directory = new WorkspaceDirectory();
    directory.replaceAll([makeWorkspace()]);
    const address = { serverId: SERVER_ID, workspaceId: "workspace-1" };
    assert.equal(directory.remove(address)?.kind, "removed");
    assert.equal(directory.remove(address), null);
    assert.equal(directory.size, 0);
  });

  it("stores frozen copies and hands out a fresh list", () => {
    const directory = new WorkspaceDirectory();
    const input = { ...makeWorkspace(), name: "original" };
    directory.upsert(input);
    input.name = "edited";
    const [stored] = directory.list();
    assert.equal(stored?.name, "original");
    assert.equal(Object.isFrozen(stored), true);
    assert.notEqual(directory.list(), directory.list());
  });
});
