import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentKey,
  freezeRecord,
  recordsEqual,
  sameAddress,
  type AgentRecord,
  type PermissionKind,
} from "../../src/agents/agent-model.ts";
import { makeRecord, SERVER_ID } from "../support/fixtures.ts";

describe("agent identity", () => {
  it("combines server and agent ID into one key", () => {
    assert.equal(agentKey({ serverId: SERVER_ID, agentId: "a" }), `${SERVER_ID}/a`);
  });

  it("never maps two different identities to the same key", () => {
    const left = agentKey({ serverId: "srv/x", agentId: "y" });
    const right = agentKey({ serverId: "srv", agentId: "x/y" });
    assert.notEqual(left, right);
  });

  it("treats the same agent ID on different servers as different agents", () => {
    assert.equal(
      sameAddress({ serverId: "srv_a", agentId: "1" }, { serverId: "srv_b", agentId: "1" }),
      false,
    );
    assert.notEqual(
      agentKey({ serverId: "srv_a", agentId: "1" }),
      agentKey({ serverId: "srv_b", agentId: "1" }),
    );
  });
});

describe("recordsEqual", () => {
  it("considers an identical copy equal", () => {
    assert.equal(recordsEqual(makeRecord(), makeRecord()), true);
  });

  const changes: [string, Partial<AgentRecord>][] = [
    ["provider", { provider: "codex" }],
    ["title", { title: "Other" }],
    ["raw status", { rawStatus: "paused", status: "unknown" }],
    ["pending permission kinds", { pendingPermissionKinds: ["tool"] }],
    ["attention flag", { requiresAttention: true }],
    ["attention reason", { attentionReason: "finished" }],
    ["archive time", { archivedAt: "2026-11-14T11:00:00.000Z" }],
    ["project name", { project: { key: "project-key-1", name: "Renamed" } }],
    ["missing project", { project: null }],
    ["workspace", { workspaceId: "workspace-2" }],
    ["missing workspace", { workspaceId: null }],
    ["parent", { parentAgentId: "parent-1" }],
    ["update time", { updatedAt: "2026-11-14T10:05:00.000Z" }],
  ];
  for (const [field, change] of changes) {
    it(`detects a change of ${field}`, () => {
      assert.equal(recordsEqual(makeRecord(), makeRecord(change)), false);
    });
  }

  it("detects a different identity", () => {
    assert.equal(recordsEqual(makeRecord({ agentId: "a" }), makeRecord({ agentId: "b" })), false);
  });
});

describe("freezeRecord", () => {
  it("returns an equal, deeply frozen copy", () => {
    const frozen = freezeRecord(makeRecord({ pendingPermissionKinds: ["tool"] }));
    assert.equal(recordsEqual(frozen, makeRecord({ pendingPermissionKinds: ["tool"] })), true);
    assert.equal(Object.isFrozen(frozen), true);
    assert.equal(Object.isFrozen(frozen.address), true);
    assert.equal(Object.isFrozen(frozen.project), true);
    assert.equal(Object.isFrozen(frozen.pendingPermissionKinds), true);
  });

  it("is detached from later edits of the input", () => {
    const kinds: PermissionKind[] = ["tool"];
    const input = {
      ...makeRecord(),
      address: { serverId: SERVER_ID, agentId: "agent-1" },
      pendingPermissionKinds: kinds,
      project: { key: "project-key-1", name: "Test project" },
    };
    const frozen = freezeRecord(input);
    input.address.agentId = "changed";
    input.pendingPermissionKinds.push("question");
    input.project.name = "changed";
    assert.equal(frozen.address.agentId, "agent-1");
    assert.deepEqual(frozen.pendingPermissionKinds, ["tool"]);
    assert.equal(frozen.project?.name, "Test project");
  });
});
