import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRecord } from "../../src/agents/agent-model.ts";
import {
  DISPLAY_STATUS_INFO,
  toDisplayStatus,
  type DisplayStatus,
} from "../../src/agents/display-status.ts";
import { makeRecord } from "../support/fixtures.ts";

function status(overrides: Partial<AgentRecord>): DisplayStatus {
  return toDisplayStatus(makeRecord(overrides));
}

describe("toDisplayStatus: specification §4 rules", () => {
  const cases: [string, Partial<AgentRecord>, DisplayStatus][] = [
    ["closed", { status: "closed" }, "closed"],
    [
      "pending question",
      { status: "running", pendingPermissionKinds: ["question"] },
      "awaiting_answer",
    ],
    [
      "pending tool permission",
      { status: "running", pendingPermissionKinds: ["tool"] },
      "awaiting_permission",
    ],
    ["lifecycle error", { status: "error" }, "error"],
    [
      "idle after a failed turn",
      { status: "idle", requiresAttention: true, attentionReason: "error" },
      "error",
    ],
    ["running", { status: "running" }, "running"],
    ["initializing", { status: "initializing" }, "starting"],
    [
      "idle with an unseen ended turn",
      { status: "idle", requiresAttention: true, attentionReason: "finished" },
      "turn_ended",
    ],
    [
      // Daemon 0.15.4 marks a failed turn "finished" too; lastError tells.
      "idle after a failed turn reported as finished",
      {
        status: "idle",
        requiresAttention: true,
        attentionReason: "finished",
        lastTurnFailed: true,
      },
      "error",
    ],
    [
      "idle with a recorded failed turn, already seen",
      { status: "idle", lastTurnFailed: true },
      "error",
    ],
    ["a new turn after a failed one", { status: "running", lastTurnFailed: true }, "running"],
    ["plain idle", { status: "idle" }, "idle"],
    ["unknown lifecycle status", { status: "unknown", rawStatus: "paused" }, "unknown"],
  ];
  for (const [name, overrides, expected] of cases) {
    it(`maps ${name} to ${expected}`, () => {
      assert.equal(status(overrides), expected);
    });
  }
});

describe("toDisplayStatus: idle, finished, closed and archived stay distinct", () => {
  it("does not treat plain idle as waiting for the user", () => {
    assert.equal(status({ status: "idle", requiresAttention: false }), "idle");
  });

  it("needs the attention flag, not only a stale reason, for a finished turn", () => {
    assert.equal(
      status({ status: "idle", requiresAttention: false, attentionReason: "finished" }),
      "idle",
    );
  });

  it("keeps archiving separate from the lifecycle", () => {
    const archived = { archivedAt: "2026-11-14T11:00:00.000Z" };
    assert.equal(status({ ...archived, status: "idle" }), "idle");
    assert.equal(status({ ...archived, status: "closed" }), "closed");
  });

  it("shows a closed agent as closed even if attention is still set", () => {
    assert.equal(
      status({ status: "closed", requiresAttention: true, attentionReason: "finished" }),
      "closed",
    );
  });
});

describe("toDisplayStatus: precedence", () => {
  it("prefers a pending question over other pending permissions", () => {
    assert.equal(
      status({ status: "running", pendingPermissionKinds: ["tool", "question"] }),
      "awaiting_answer",
    );
  });

  it("shows waiting even when the lifecycle reports an error", () => {
    assert.equal(
      status({ status: "error", pendingPermissionKinds: ["plan"] }),
      "awaiting_permission",
    );
  });

  it("uses pending permissions, not the attention reason, as the waiting source", () => {
    assert.equal(
      status({ status: "idle", requiresAttention: true, attentionReason: "permission" }),
      "idle",
    );
  });

  it("ignores a previous turn's attention reason while a new turn runs", () => {
    assert.equal(
      status({ status: "running", requiresAttention: true, attentionReason: "finished" }),
      "running",
    );
    assert.equal(
      status({ status: "running", requiresAttention: true, attentionReason: "error" }),
      "running",
    );
    assert.equal(
      status({ status: "initializing", requiresAttention: true, attentionReason: "error" }),
      "starting",
    );
  });

  it("never reads an ended turn of a parent or subagent as a finished task", () => {
    const ended = { status: "idle", requiresAttention: true, attentionReason: "finished" } as const;
    assert.equal(status({ ...ended, parentAgentId: "parent-1" }), "turn_ended");
    assert.equal(status(ended), "turn_ended");
    assert.equal(status({ status: "idle", parentAgentId: "parent-1" }), "idle");
  });

  it("still shows pending permissions of an agent with an unknown status", () => {
    assert.equal(
      status({ status: "unknown", rawStatus: "paused", pendingPermissionKinds: ["other"] }),
      "awaiting_permission",
    );
  });
});

describe("DISPLAY_STATUS_INFO", () => {
  it("uses distinct, short English labels that fit one key line", () => {
    const labels = Object.values(DISPLAY_STATUS_INFO).map((info) => info.label);
    assert.deepEqual(labels, [
      "Question?",
      "Approval?",
      "Error",
      "Starting",
      "Running",
      "Turn ended",
      "Idle",
      "Closed",
      "Unknown",
    ]);
    assert.equal(new Set(labels).size, labels.length);
    for (const label of labels) assert.ok(label.length <= 10, label);
    assert.notEqual(DISPLAY_STATUS_INFO.idle.label, DISPLAY_STATUS_INFO.turn_ended.label);
  });
});
