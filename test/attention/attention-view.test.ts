import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRecord } from "../../src/agents/agent-model.ts";
import {
  attentionDisplay,
  attentionIndex,
  attentionItems,
  type AttentionFacts,
} from "../../src/attention/attention-view.ts";
import { ERROR_WORDS } from "../../src/spike/key-view.ts";
import { makeRecord, SERVER_ID } from "../support/fixtures.ts";

const OTHER = "srv_OtherHost02";
const word = (code: keyof typeof ERROR_WORDS) => ERROR_WORDS[code];

/** Synthetic agents only. */
function agent(agentId: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return makeRecord({ agentId, title: `Agent ${agentId}`, ...overrides });
}
const question = (id: string, more: Partial<AgentRecord> = {}) =>
  agent(id, { status: "running", pendingPermissionKinds: ["question"], ...more });
const approval = (id: string, more: Partial<AgentRecord> = {}) =>
  agent(id, { pendingPermissionKinds: ["tool"], ...more });
const failed = (id: string, more: Partial<AgentRecord> = {}) =>
  agent(id, { status: "idle", lastTurnFailed: true, ...more });

function facts(agents: readonly AgentRecord[], more: Partial<AttentionFacts> = {}): AttentionFacts {
  return {
    connection: "ok",
    link: "connected",
    stale: false,
    failure: null,
    ready: true,
    serverId: SERVER_ID,
    agents,
    truncated: false,
    ...more,
  };
}

const ids = (input: AttentionFacts) =>
  attentionItems(input).map((item) => item.record.address.agentId);

describe("attentionItems", () => {
  it("keeps questions, approvals and errors of the current host, in compareAgents order", () => {
    const list = facts([
      agent("running", { status: "running" }),
      agent("idle"),
      agent("ended", { requiresAttention: true, attentionReason: "finished" }),
      failed("err", { updatedAt: "2026-11-16T10:00:00.000Z" }),
      approval("perm", { updatedAt: "2026-11-15T10:00:00.000Z" }),
      question("ask", { updatedAt: "2026-11-16T09:00:00.000Z" }),
      agent("unknown", { status: "unknown", rawStatus: "paused" }),
      agent("lifecycle-error", { status: "error" }),
    ]);
    assert.deepEqual(ids(list), ["ask", "perm", "err", "lifecycle-error"]);
  });

  it("excludes closed, archived and other hosts' agents; keeps unplaced ones", () => {
    const list = facts([
      question("closed", { status: "closed" }),
      question("archived", { archivedAt: "2026-11-16T00:00:00.000Z" }),
      { ...question("foreign"), address: { serverId: OTHER, agentId: "foreign" } },
      question("unplaced", { workspaceId: null, project: null }),
    ]);
    assert.deepEqual(ids(list), ["unplaced"]);
    assert.deepEqual(ids(facts(list.agents, { serverId: null })), [], "host not known yet");
  });

  it("drops an agent once its error recovers into a running turn", () => {
    assert.deepEqual(ids(facts([failed("a", { status: "running" })])), []);
  });

  it("finds the shown agent by identity, else the first", () => {
    const items = attentionItems(facts([question("a"), question("b")]));
    assert.equal(attentionIndex(items, items[1]?.key ?? null), 1);
    assert.equal(attentionIndex(items, "gone"), 0);
  });
});

describe("attentionDisplay", () => {
  it("shows reason (yellow or red), white name, counter and project", () => {
    const list = facts([question("a", { project: { key: "p", name: "paseo-web" } }), failed("b")]);
    assert.deepEqual(attentionDisplay(list, 0, word), {
      label: "Question?",
      labelInk: "question",
      counter: "1/2",
      value: "Agent a",
      valueInk: "white",
      hint: "Press to open · paseo-web",
      target: attentionItems(list)[0]?.key,
    });
    const error = attentionDisplay(list, 1, word);
    assert.equal(error.label, "Error");
    assert.equal(error.labelInk, "error");
    assert.equal(error.valueInk, "white");
    assert.equal(attentionDisplay(facts([approval("c")]), 0, word).label, "Approval?");
    assert.equal(
      attentionDisplay(facts([question("d", { title: null })]), 0, word).value,
      "(untitled)",
    );
    assert.equal(attentionDisplay(list, 9, word).counter, "2/2", "position clamped");
  });

  it("never shows No alerts unless the list is current and complete", () => {
    assert.equal(attentionDisplay(facts([]), 0, word).value, "No alerts");
    const offline = attentionDisplay(facts([], { link: "reconnecting" }), 0, word);
    assert.equal(offline.value, "Offline");
    const stale = attentionDisplay(facts([], { stale: true }), 0, word);
    assert.equal(stale.value, "Updating…");
    const truncated = attentionDisplay(facts([], { truncated: true }), 0, word);
    assert.deepEqual(
      [truncated.value, truncated.hint],
      ["None in first 200", "More agents exist · not checked"],
    );
    assert.equal(truncated.valueInk, "calm");
    assert.equal(offline.hint, "No current data");
    assert.equal(stale.hint, "No current data");
    const failedFeed = attentionDisplay(facts([], { failure: "subscription_failed" }), 0, word);
    assert.equal(failedFeed.value, "Paseo error");
    for (const shown of [offline, stale, truncated, failedFeed]) {
      assert.notEqual(shown.value, "No alerts");
      assert.equal(shown.target, null);
    }
  });

  it("marks a partial list on the counter and in the hint", () => {
    const shown = attentionDisplay(facts([question("a")], { truncated: true }), 0, word);
    assert.equal(shown.counter, "1/1+");
    assert.match(shown.hint, /First 200 agents only/);
  });

  it("greys last known items while offline, stale or failed, and still names the target", () => {
    for (const [more, mark] of [
      [{ link: "reconnecting" as const }, "Offline · last known"],
      [{ stale: true }, "Updating… · last known"],
      [{ failure: "subscription_failed" as const }, "Paseo error · last known"],
    ] as const) {
      const shown = attentionDisplay(facts([question("a")], more), 0, word);
      assert.equal(shown.hint, mark);
      assert.equal(shown.labelInk, "muted");
      assert.equal(shown.valueInk, "muted");
      assert.notEqual(shown.target, null);
    }
  });

  it("tells the connection state, feed errors, loading and offline apart before data", () => {
    // C3a3: the connection state replaces "missing config"; nothing is unconfigured.
    assert.equal(attentionDisplay(facts([], { connection: "loading" }), 0, word).value, "Loading…");
    assert.equal(
      attentionDisplay(facts([], { connection: "unavailable" }), 0, word).hint,
      "Settings unavailable",
    );
    assert.equal(
      attentionDisplay(facts([], { connection: "invalid" }), 0, word).hint,
      "Reason: config",
    );
    assert.equal(
      attentionDisplay(facts([], { connection: "switch_blocked" }), 0, word).hint,
      "Restart the plugin",
    );
    const notReady = { ready: false } as const;
    assert.deepEqual(
      [attentionDisplay(facts([], { ...notReady, failure: "auth_failed" }), 0, word).hint],
      ["Reason: auth"],
    );
    assert.equal(
      attentionDisplay(facts([], { ...notReady, link: "connecting" }), 0, word).value,
      "Loading…",
    );
    assert.equal(
      attentionDisplay(facts([], { ...notReady, link: "reconnecting" }), 0, word).value,
      "Offline",
    );
  });

  it("shows only title and project, never permission or error details", () => {
    const shown = attentionDisplay(
      facts([approval("a", { title: "Fix build", project: { key: "p", name: "api" } })]),
      0,
      word,
    );
    assert.deepEqual([shown.value, shown.hint], ["Fix build", "Press to open · api"]);
  });
});

describe("attentionDisplay: waiting for first data on a live connection", () => {
  it("is loading, not offline, while connected and not ready", () => {
    const shown = attentionDisplay(
      facts([], { ready: false, stale: true, link: "connected" }),
      0,
      word,
    );
    assert.equal(shown.value, "Loading…");
  });

  it("never claims No alerts without a known host", () => {
    const shown = attentionDisplay(facts([], { serverId: null }), 0, word);
    assert.equal(shown.value, "Loading…");
    assert.equal(shown.target, null);
  });
});

describe("attentionDisplay: the empty list states its narrow scope", () => {
  it("says No alerts with the covered kinds, never that nothing needs the user", () => {
    const shown = attentionDisplay(facts([]), 0, word);
    assert.deepEqual([shown.value, shown.hint], ["No alerts", "Questions · approvals · errors"]);
    assert.doesNotMatch(`${shown.value} ${shown.hint}`, /nothing pending|needs attention/i);
  });
});
