import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sameLinkState, toLinkState } from "../../src/paseo/link-state.ts";

describe("toLinkState", () => {
  it("reports the first connection attempt as connecting", () => {
    assert.deepEqual(toLinkState({ status: "connecting", attempt: 0 }, false), {
      kind: "connecting",
    });
  });

  it("keeps a never-reached daemon as disconnected across SDK retries", () => {
    assert.equal(toLinkState({ status: "disconnected", reason: "x" }, false).kind, "disconnected");
    assert.equal(toLinkState({ status: "connecting", attempt: 2 }, false).kind, "disconnected");
  });

  it("reports loss of a live connection as reconnecting", () => {
    assert.equal(toLinkState({ status: "disconnected" }, true).kind, "reconnecting");
    assert.equal(toLinkState({ status: "connecting", attempt: 1 }, true).kind, "reconnecting");
  });

  it("recognizes authentication failures", () => {
    assert.deepEqual(toLinkState({ status: "disconnected", reason: "Incorrect password" }, true), {
      kind: "auth_failed",
    });
    assert.equal(
      toLinkState({ status: "disconnected", reason: "Password required" }, false).kind,
      "auth_failed",
    );
  });

  it("maps connected, idle and disposed", () => {
    assert.equal(toLinkState({ status: "connected" }, false).kind, "connected");
    assert.equal(toLinkState({ status: "idle" }, false).kind, "idle");
    assert.equal(toLinkState({ status: "disposed" }, true).kind, "closed");
  });

  it("compares states by kind only", () => {
    assert.equal(sameLinkState({ kind: "reconnecting" }, { kind: "reconnecting" }), true);
    assert.equal(sameLinkState({ kind: "connected" }, { kind: "reconnecting" }), false);
  });
});
