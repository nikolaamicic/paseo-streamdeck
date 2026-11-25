import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attentionDisplay, type AttentionFacts } from "../../src/attention/attention-view.ts";
import { AgentFeed } from "../../src/paseo/agent-feed.ts";
import { ERROR_WORDS } from "../../src/spike/key-view.ts";
import { FakeClient, flush, ManualScheduler } from "../support/fake-client.ts";

/** The same mapping from a feed as plugin.ts (config is valid here). */
function factsOf(feed: AgentFeed): AttentionFacts {
  return {
    connection: "ok",
    link: feed.linkState.kind,
    stale: feed.stale,
    failure: feed.failure,
    ready: feed.ready,
    serverId: feed.serverId,
    agents: feed.directory.list(),
    truncated: feed.truncated,
  };
}

describe("Attention on a real feed before both first snapshots", () => {
  for (const waiting of ["agents", "workspaces"] as const) {
    it(`shows Loading… while the ${waiting} snapshot is still missing`, async () => {
      const client = new FakeClient();
      if (waiting === "agents") client.deliverInitialSnapshot = false;
      else client.workspaces.deliverInitialSnapshot = false;
      const scheduler = new ManualScheduler();
      const feed = new AgentFeed(client, {}, { scheduler });
      void feed.start().catch(() => undefined);
      await flush();
      scheduler.tick();
      assert.equal(feed.linkState.kind, "connected");
      assert.equal(feed.ready, false);
      const shown = attentionDisplay(factsOf(feed), 0, (code) => ERROR_WORDS[code]);
      assert.equal(shown.value, "Loading…");
      await feed.close();
    });
  }
});
