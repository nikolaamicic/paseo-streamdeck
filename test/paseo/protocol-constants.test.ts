import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { AGENT_LIFECYCLE_STATUSES } from "@getpaseo/protocol/agent-lifecycle";
import { AGENT_STATUSES } from "../../src/agents/agent-model.ts";
import { parseAgent } from "../../src/paseo/agent-parser.ts";
import { SERVER_ID } from "../support/fixtures.ts";

/**
 * Drift guards (M2): local copies of constants that @getpaseo/protocol
 * 0.15.4 exports publicly (subpath exports `agent-lifecycle` and
 * `agent-labels`). The model keeps its own copies so it does not import
 * the SDK at runtime; only these tests import the protocol. Values that the
 * protocol does not export as constants (attention reasons and permission
 * kinds exist only as types; the 200-entry page limit and connection-state
 * strings have no public constant) are not guarded here.
 */

function agentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "agent-1",
    provider: "claude",
    status: "idle",
    pendingPermissions: [],
    ...overrides,
  };
}

describe("protocol constant guards", () => {
  it("knows exactly the protocol's agent lifecycle statuses (order is not part of the contract)", () => {
    assert.deepEqual([...AGENT_STATUSES].sort(), [...AGENT_LIFECYCLE_STATUSES].sort());
  });

  it("keeps every protocol lifecycle status as itself, never as unknown", () => {
    for (const status of AGENT_LIFECYCLE_STATUSES) {
      const parsed = parseAgent(SERVER_ID, agentPayload({ status }), null);
      assert.ok(parsed.ok, status);
      assert.equal(parsed.value.status, status);
    }
  });

  it("reads the parent agent from the protocol's parent label", () => {
    const parsed = parseAgent(
      SERVER_ID,
      agentPayload({ labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" } }),
      null,
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.value.parentAgentId, "parent-1");
  });
});
