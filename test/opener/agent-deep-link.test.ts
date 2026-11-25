import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import { agentDeepLink, isAgentDeepLinkFor } from "../../src/opener/agent-deep-link.ts";

const TARGET = { serverId: "srv_TestServer01", agentId: "11111111-2222-4333-8444-555555555555" };
const URL_FOR_TARGET = "paseo://h/srv_TestServer01/agent/11111111-2222-4333-8444-555555555555";

describe("agentDeepLink", () => {
  it("builds the exact protocol route and round-trips through the app's parser", () => {
    assert.equal(agentDeepLink(TARGET), URL_FOR_TARGET);
    assert.deepEqual(parseAgentDeepLink(URL_FOR_TARGET), TARGET);
  });

  const invalid: [string, { serverId: string; agentId: string }][] = [
    ["an empty agent ID", { ...TARGET, agentId: "" }],
    ["a path separator", { ...TARGET, agentId: "a/../b" }],
    ["whitespace", { ...TARGET, agentId: "a b" }],
    ["query and fragment characters", { ...TARGET, agentId: "a?x=1#y" }],
    ["shell metacharacters", { ...TARGET, agentId: "a;open -a Calculator" }],
    ["non-ASCII", { ...TARGET, serverId: "srv_ć" }],
    ["a leading dash", { ...TARGET, agentId: "-a" }],
    ["an overlong ID", { ...TARGET, agentId: "a".repeat(129) }],
  ];
  for (const [name, address] of invalid) {
    it(`refuses ${name}`, () => {
      assert.equal(agentDeepLink(address), null);
    });
  }
});

describe("isAgentDeepLinkFor", () => {
  for (const url of [
    `${URL_FOR_TARGET}?x=1`,
    `${URL_FOR_TARGET}#x`,
    `${URL_FOR_TARGET}/`,
    URL_FOR_TARGET.replace("paseo://", "PASEO://"),
    URL_FOR_TARGET.replace("paseo://h/", "paseo://user@h/"),
    URL_FOR_TARGET.replace("paseo:", "https:"),
    ` ${URL_FOR_TARGET}`,
  ]) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      assert.equal(isAgentDeepLinkFor(url, TARGET), false);
    });
  }

  it("rejects a valid link of another agent", () => {
    assert.equal(isAgentDeepLinkFor(URL_FOR_TARGET, { ...TARGET, agentId: "other" }), false);
  });
});
