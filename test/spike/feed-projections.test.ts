import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentFeedErrorCode } from "../../src/paseo/feed-diagnostics.ts";
import type { LinkState } from "../../src/paseo/link-state.ts";
import type { RecoveryState } from "../../src/paseo/feed-recovery.ts";
import {
  attentionFacts,
  connectionState,
  feedInputs,
  inspectorFacts,
  navigationFacts,
  renderAllSteps,
  usageFacts,
  usageSource,
  type ProjectedFeed,
  type ProjectionSource,
  type RenderSteps,
} from "../../src/spike/feed-projections.ts";
import type { ConnectionView } from "../../src/spike/feed-lifecycle.ts";
import { makeRecord, makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

/**
 * Characterization of plugin.ts's feed projections and redraw order (M4),
 * on plain fake feed and recovery objects. The projections are the ones
 * plugin.ts calls; nothing here connects to a daemon.
 */

const RECORD = makeRecord({ agentId: "agent-1" });
const OTHER = makeRecord({ agentId: "agent-2" });
const WORKSPACE = makeWorkspace();
const ACTIVE: ConnectionView = {
  kind: "active",
  daemonUrl: "ws://127.0.0.1:6767/ws",
  source: "default",
};

interface FeedOptions {
  link?: LinkState["kind"];
  stale?: boolean;
  failure?: AgentFeedErrorCode | null;
  serverId?: string | null;
  ready?: boolean;
  truncated?: boolean;
  workspacesTruncated?: boolean;
  connectionEpoch?: number;
}

/** The feed's project list (P1), passed through unchanged to navigation and inspector. */
const PROJECTS = {
  status: "not_live" as const,
  projects: [{ address: { serverId: SERVER_ID, projectId: "p-alpha" }, name: "Alpha" }],
  current: false,
};

/** A feed with the fields the projections read; listUsage calls are counted. */
function fakeFeed(options: FeedOptions = {}) {
  const usageCalls: number[] = [];
  const answer = { providers: [] };
  const feed: ProjectedFeed = {
    linkState: { kind: options.link ?? "connected" },
    stale: options.stale ?? false,
    failure: options.failure ?? null,
    serverId: options.serverId === undefined ? SERVER_ID : options.serverId,
    ready: options.ready ?? true,
    truncated: options.truncated ?? false,
    workspacesTruncated: options.workspacesTruncated ?? false,
    connectionEpoch: options.connectionEpoch ?? 1,
    workspaceList: () => [WORKSPACE],
    projects: PROJECTS,
    retryProjects: () => false,
    listUsage: () => {
      usageCalls.push(1);
      return Promise.resolve(answer);
    },
    directory: {
      get: (address) => [RECORD, OTHER].find((r) => r.address.agentId === address.agentId),
      list: () => [RECORD, OTHER],
    },
  };
  return { feed, usageCalls, answer };
}

function source(
  feed: ProjectedFeed | null,
  state: RecoveryState = { kind: "running" },
  retryAvailable = false,
): ProjectionSource {
  return { connection: ACTIVE, recovery: { feed, state, retryAvailable } };
}

describe("feed projections without a feed", () => {
  it("while the sources load: loading, idle, nothing to ask", () => {
    const empty: ProjectionSource = {
      connection: { kind: "loading" },
      recovery: null,
    };
    assert.deepEqual(feedInputs(empty), {
      connection: "loading",
      link: "idle",
      stale: false,
      failure: null,
      recoveryError: null,
      retryAvailable: false,
      serverId: null,
      hasSnapshot: false,
    });
    assert.deepEqual(navigationFacts(empty), {
      ready: false,
      stale: false,
      link: "idle",
      serverId: null,
      agents: [],
      workspaces: [],
      truncated: false,
      agentsTruncated: false,
      projects: { status: "loading", projects: [], current: false },
    });
    assert.equal(inspectorFacts(empty).connection, "loading");
    assert.equal(inspectorFacts(empty).projects.current, false, "no feed: never current");
    assert.equal(attentionFacts(empty).connection, "loading");
    assert.equal(usageSource(empty), null);
    assert.deepEqual(usageFacts(empty), { connected: false });
  });

  it("unreadable settings are 'unavailable'; every other block is 'invalid'", () => {
    const cases: [ConnectionView, string][] = [
      [{ kind: "blocked", reason: "settings_unavailable" }, "unavailable"],
      [{ kind: "blocked", reason: "settings_malformed" }, "invalid"],
      [{ kind: "blocked", reason: "saved_invalid" }, "invalid"],
      [{ kind: "blocked", reason: "legacy_unreadable" }, "invalid"],
      [{ kind: "blocked", reason: "legacy_malformed" }, "invalid"],
      [{ kind: "blocked", reason: "legacy_invalid_address" }, "invalid"],
      [{ kind: "blocked", reason: "legacy_invalid_target_only" }, "invalid"],
      // C3b2: closing the old connection shows loading, never connected.
      [{ kind: "switching" }, "loading"],
      [{ kind: "switch_blocked" }, "switch_blocked"],
      [ACTIVE, "ok"],
    ];
    for (const [connection, state] of cases) {
      assert.equal(connectionState(connection), state);
      const blocked: ProjectionSource = { connection, recovery: null };
      assert.equal(feedInputs(blocked).connection, state);
      assert.equal(attentionFacts(blocked).connection, state);
      assert.equal(inspectorFacts(blocked).connection, state);
    }
  });
});

describe("feed projections of a feed", () => {
  it("follows link, readiness and staleness the same way everywhere", () => {
    const { feed } = fakeFeed({ link: "reconnecting", stale: true, ready: false });
    const s = source(feed);
    assert.deepEqual(
      [feedInputs(s).link, feedInputs(s).stale, feedInputs(s).hasSnapshot],
      ["reconnecting", true, false],
    );
    assert.deepEqual(
      [navigationFacts(s).link, navigationFacts(s).stale, navigationFacts(s).ready],
      ["reconnecting", true, false],
    );
    assert.deepEqual([inspectorFacts(s).link, inspectorFacts(s).ready], ["reconnecting", false]);
    assert.deepEqual([attentionFacts(s).link, attentionFacts(s).ready], ["reconnecting", false]);
    assert.deepEqual(usageFacts(s), { connected: false });
  });

  it("keeps feed failure and recovery error apart for keys; inspector and Attention prefer recovery", () => {
    const { feed } = fakeFeed({ failure: "subscription_failed" });
    const both = source(feed, { kind: "waiting", error: "connect_failed" }, true);
    const inputs = feedInputs(both);
    assert.deepEqual(
      [inputs.failure, inputs.recoveryError, inputs.retryAvailable],
      ["subscription_failed", "connect_failed", true],
    );
    assert.equal(inspectorFacts(both).failure, "connect_failed");
    assert.equal(attentionFacts(both).failure, "connect_failed");

    const feedOnly = source(feed, { kind: "running" });
    assert.equal(feedInputs(feedOnly).recoveryError, null);
    assert.equal(inspectorFacts(feedOnly).failure, "subscription_failed");
    assert.equal(attentionFacts(feedOnly).failure, "subscription_failed");

    const recoveryOnly = source(null, { kind: "blocked", error: "auth_failed" });
    assert.equal(feedInputs(recoveryOnly).failure, null);
    assert.equal(feedInputs(recoveryOnly).recoveryError, "auth_failed");
    assert.equal(inspectorFacts(recoveryOnly).failure, "auth_failed");
  });

  it("uses agent truncation for Attention and workspace truncation for navigation and inspector", () => {
    const agentsOnly = source(fakeFeed({ truncated: true }).feed);
    assert.equal(attentionFacts(agentsOnly).truncated, true);
    assert.equal(navigationFacts(agentsOnly).truncated, false);
    assert.equal(navigationFacts(agentsOnly).agentsTruncated, true, "for N+ counts (P2)");
    assert.equal(navigationFacts(agentsOnly).projects, PROJECTS, "the feed's project list as is");
    assert.equal(inspectorFacts(agentsOnly).projects, PROJECTS);
    assert.equal(inspectorFacts(agentsOnly).truncated, false);

    const workspacesOnly = source(fakeFeed({ workspacesTruncated: true }).feed);
    assert.equal(attentionFacts(workspacesOnly).truncated, false);
    assert.equal(navigationFacts(workspacesOnly).truncated, true);
    assert.equal(inspectorFacts(workspacesOnly).truncated, true);
  });

  it("navigation and Attention list the directory; navigation and inspector the workspaces", () => {
    const s = source(fakeFeed().feed);
    assert.deepEqual(navigationFacts(s).agents, [RECORD, OTHER]);
    assert.deepEqual(attentionFacts(s).agents, [RECORD, OTHER]);
    assert.deepEqual(navigationFacts(s).workspaces, [WORKSPACE]);
    assert.deepEqual(inspectorFacts(s).workspaces, [WORKSPACE]);
  });
});

describe("usage source", () => {
  it("is the feed itself: owner, epoch, host, connection and settled state", () => {
    const { feed } = fakeFeed({ connectionEpoch: 4, serverId: "srv_TestServer09" });
    const usage = usageSource(source(feed));
    assert.ok(usage);
    assert.equal(usage.owner, feed, "same feed instance, so its generation is tracked");
    assert.deepEqual(
      [usage.connectionEpoch, usage.serverId, usage.connected, usage.settled],
      [4, "srv_TestServer09", true, true],
    );
    for (const [options, settled] of [
      [{ stale: true }, false],
      [{ ready: false }, false],
    ] as const) {
      assert.equal(usageSource(source(fakeFeed(options).feed))?.settled, settled);
    }
  });

  it("passes listUsage through to the same feed and asks nothing while being read", async () => {
    const { feed, usageCalls, answer } = fakeFeed();
    const usage = usageSource(source(feed));
    usageFacts(source(feed));
    assert.equal(usageCalls.length, 0, "reading facts and the source sends no request");
    assert.ok(usage);
    assert.equal(await usage.listUsage(), answer);
    assert.equal(usageCalls.length, 1);
  });
});

describe("renderAllSteps", () => {
  it("syncs navigation before any view, and usage before the Usage dials", () => {
    const order: string[] = [];
    let placed = "old placement";
    let pollerState = "old usage";
    const seen: Record<string, string> = {};
    const steps: RenderSteps = {
      syncNavigation: () => {
        order.push("syncNavigation");
        placed = "new placement";
      },
      presentSlotKeys: () => {
        order.push("presentSlotKeys");
        seen["slots"] = placed;
      },
      showPagesStrips: () => {
        order.push("showPagesStrips");
        seen["pages"] = placed;
      },
      refreshWorkspaceDials: () => {
        order.push("refreshWorkspaceDials");
        seen["workspace"] = placed;
      },
      syncUsage: () => {
        order.push("syncUsage");
        pollerState = "new usage";
      },
      refreshUsageDials: () => {
        order.push("refreshUsageDials");
        seen["usage"] = pollerState;
      },
      refreshAttentionDials: () => {
        order.push("refreshAttentionDials");
      },
    };
    renderAllSteps(steps);
    assert.deepEqual(order, [
      "syncNavigation",
      "presentSlotKeys",
      "showPagesStrips",
      "refreshWorkspaceDials",
      "syncUsage",
      "refreshUsageDials",
      "refreshAttentionDials",
    ]);
    assert.deepEqual(seen, {
      slots: "new placement",
      pages: "new placement",
      workspace: "new placement",
      usage: "new usage",
    });
  });
});
