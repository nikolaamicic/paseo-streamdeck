import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decidePress, type PressInputs } from "../../src/spike/press-guard.ts";

const A = { serverId: "srv_TestServer01", agentId: "agent-a" };
const B = { serverId: "srv_TestServer01", agentId: "agent-b" };
const base: PressInputs = {
  rendered: A,
  renderedRetry: false,
  changePending: false,
  configured: A,
  current: A,
};

describe("decidePress", () => {
  it("opens exactly the rendered, configured and current identity", () => {
    assert.deepEqual(decidePress(base), { kind: "open", target: A });
  });

  const refusals: [string, Partial<PressInputs>, string][] = [
    ["nothing was drawn yet", { rendered: null }, "nothing_shown"],
    ["the identity on the key is changing", { changePending: true }, "identity_changing"],
    [
      "the drawn Retry is about to change",
      { rendered: null, renderedRetry: true, changePending: true },
      "identity_changing",
    ],
    ["the key shows neither an agent nor Retry", { rendered: null }, "nothing_shown"],
    ["the drawn identity is not the configured one", { rendered: B }, "not_configured"],
    ["no agent is configured", { configured: null }, "not_configured"],
    ["the agent is no longer in the directory", { current: null }, "not_current"],
    ["the directory holds a different agent", { current: B }, "not_current"],
  ];
  it("asks for a retry only when the drawn key offered Retry and nothing is pending", () => {
    const shown = { rendered: null, renderedRetry: true, configured: A, current: null };
    assert.deepEqual(decidePress({ ...base, ...shown }), { kind: "retry" });
  });

  for (const [name, overrides, reason] of refusals) {
    it(`refuses when ${name}`, () => {
      assert.deepEqual(decidePress({ ...base, ...overrides }), { kind: "refuse", reason });
    });
  }
});
