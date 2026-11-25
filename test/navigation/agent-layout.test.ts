import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRecord } from "../../src/agents/agent-model.ts";
import { AgentLayout } from "../../src/navigation/agent-layout.ts";
import { makeRecord } from "../support/fixtures.ts";

const ids = (layout: AgentLayout) =>
  Array.from({ length: layout.size }, (_, index) => layout.at(index)?.agentId ?? null);

const agent = (agentId: string, overrides: Partial<AgentRecord> = {}) =>
  makeRecord({ agentId, ...overrides });

describe("AgentLayout", () => {
  it("arranges by priority, then most recent, then ID", () => {
    const layout = new AgentLayout();
    layout.arrange([
      agent("idle-old", { updatedAt: "2026-11-14T10:00:00.000Z" }),
      agent("idle-new", { updatedAt: "2026-11-14T11:00:00.000Z" }),
      agent("running", { status: "running", rawStatus: "running" }),
      agent("asks", { pendingPermissionKinds: ["question"] }),
      agent("failed", { status: "error", rawStatus: "error" }),
      agent("closed", { status: "closed", rawStatus: "closed" }),
    ]);
    assert.deepEqual(ids(layout), ["asks", "failed", "running", "idle-new", "idle-old", "closed"]);
  });

  it("keeps positions on status changes, leaves holes and appends new agents", () => {
    const layout = new AgentLayout();
    layout.arrange([agent("a"), agent("b"), agent("c")]);
    const changed = [agent("a"), agent("b", { status: "error", rawStatus: "error" }), agent("c")];
    assert.equal(layout.update(changed, changed), false, "a status change moves nothing");
    assert.deepEqual(ids(layout), ["a", "b", "c"]);
    const next = [agent("a"), agent("c"), agent("d")];
    assert.equal(layout.update(next, next), true);
    assert.deepEqual(ids(layout), ["a", null, "c", "d"], "removed b leaves a hole, d is appended");
    assert.equal(layout.agentCount, 3);
    layout.update([agent("a"), agent("c")], [agent("a"), agent("c")]);
    assert.deepEqual(ids(layout), ["a", null, "c"], "trailing holes are trimmed");
  });

  it("keeps an agent that stops matching in place until the next arrange (§6 rule 6)", () => {
    const layout = new AgentLayout();
    layout.arrange([agent("a"), agent("b"), agent("c")]);
    const moved = agent("b", { workspaceId: "elsewhere" });
    assert.equal(
      layout.update([agent("a"), agent("c")], [agent("a"), moved, agent("c")]),
      false,
      "b is still on the host: no hole, no move",
    );
    assert.deepEqual(ids(layout), ["a", "b", "c"]);
    layout.update([agent("a"), agent("c"), agent("b")], [agent("a"), agent("b"), agent("c")]);
    assert.deepEqual(
      ids(layout),
      ["a", "b", "c"],
      "back in the workspace: same place, not appended",
    );
  });

  it("counts pages of eight, at least one", () => {
    const layout = new AgentLayout();
    assert.equal(layout.pageCount, 1);
    layout.arrange(
      Array.from({ length: 17 }, (_, index) => agent(`a${String(index).padStart(2, "0")}`)),
    );
    assert.equal(layout.pageCount, 3);
    assert.equal(layout.at(16)?.agentId, "a16");
    assert.equal(layout.at(17), null);
  });
});
