import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_DAEMON_URL, defaultConfigPath } from "../../src/spike/test-agent-config.ts";

/**
 * The legacy E1 file's location and the default address. Reading and
 * interpreting the file are covered by test/connection (C2, C3a1).
 */
describe("legacy E1 file location", () => {
  it("lives under the user's home, as documented", () => {
    assert.equal(
      defaultConfigPath("/home/someone"),
      "/home/someone/.config/paseo-control/e1-test-agent.json",
    );
  });

  it("the default address is the documented local daemon", () => {
    assert.equal(DEFAULT_DAEMON_URL, "ws://127.0.0.1:6767/ws");
  });
});
