import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openAgent, type ProcessRunner } from "../../src/opener/open-agent.ts";

const TARGET = { serverId: "srv_TestServer01", agentId: "11111111-2222-4333-8444-555555555555" };

function recorder(fail = false) {
  const calls: { file: string; args: string[] }[] = [];
  const run: ProcessRunner = (file, args) => {
    calls.push({ file, args: [...args] });
    return fail ? Promise.reject(new Error("exit 1")) : Promise.resolve();
  };
  return { calls, run };
}

describe("openAgent", () => {
  it("runs /usr/bin/open with the link as its only argument", async () => {
    const { calls, run } = recorder();
    assert.equal(await openAgent(TARGET, run, "darwin"), "requested");
    assert.deepEqual(calls, [
      {
        file: "/usr/bin/open",
        args: ["paseo://h/srv_TestServer01/agent/11111111-2222-4333-8444-555555555555"],
      },
    ]);
  });

  it("launches nothing for an invalid target or outside macOS", async () => {
    const { calls, run } = recorder();
    assert.equal(
      await openAgent({ ...TARGET, agentId: "x; rm -rf ~" }, run, "darwin"),
      "invalid_target",
    );
    assert.equal(await openAgent(TARGET, run, "linux"), "unsupported_platform");
    assert.equal(calls.length, 0);
  });

  it("reports a failed launch as a code, not as success", async () => {
    const { run } = recorder(true);
    assert.equal(await openAgent(TARGET, run, "darwin"), "launch_failed");
  });
});
