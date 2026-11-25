import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sameKeyView,
  slotKeyView,
  type KeyView,
  type SlotInputs,
} from "../../src/spike/key-view.ts";
import { makeRecord, SERVER_ID } from "../support/fixtures.ts";

const TARGET = { serverId: SERVER_ID, agentId: "agent-1" };

function inputs(overrides: Partial<SlotInputs> = {}): SlotInputs {
  return {
    connection: "ok",
    slot: TARGET,
    dimmed: false,
    link: "connected",
    stale: false,
    failure: null,
    recoveryError: null,
    retryAvailable: false,
    serverId: SERVER_ID,
    hasSnapshot: true,
    record: makeRecord({ status: "running", rawStatus: "running" }),
    ...overrides,
  };
}

function messageLines(view: KeyView): readonly string[] {
  assert.equal(view.face.kind, "message");
  return view.face.lines;
}

function connection(view: KeyView): string {
  assert.equal(view.face.kind, "agent");
  return view.face.connection;
}

/*
 * The agent key's view through slotKeyView, the only agent key since the E1
 * action was removed (the owner, 2026-11-25). These cases were the E1 key's;
 * the connection, feed and agent paths are the same code (connectionMessage,
 * feedMessage, agentView). Slot-only cases follow below.
 */
describe("agent key view", () => {
  it("shows the placed agent's status, title, provider and project with its identity", () => {
    const view = slotKeyView(inputs());
    assert.deepEqual(view.identity, TARGET);
    assert.deepEqual(view.face, {
      kind: "agent",
      status: "running",
      title: "Test agent",
      provider: "claude",
      project: "Test project",
      subagent: false,
      archived: false,
      connection: "live",
      dimmed: false,
    });
  });

  it("passes subagent, archived and missing title/project through for drawing", () => {
    const view = slotKeyView(
      inputs({
        record: makeRecord({
          title: null,
          project: null,
          parentAgentId: "agent-0",
          archivedAt: "2026-11-15T10:00:00.000Z",
        }),
      }),
    );
    assert.equal(view.face.kind, "agent");
    assert.equal(view.face.title, null);
    assert.equal(view.face.project, null);
    assert.equal(view.face.subagent, true);
    assert.equal(view.face.archived, true);
  });

  it("shows the connection state before the agent", () => {
    assert.deepEqual(messageLines(slotKeyView(inputs({ connection: "loading" }))), ["Loading"]);
    const unavailable = slotKeyView(inputs({ connection: "unavailable" }));
    assert.deepEqual(messageLines(unavailable), ["Paseo", "settings", "Retry"]);
    assert.equal(unavailable.retry, true, "a press reads the settings again");
    const invalid = slotKeyView(inputs({ connection: "invalid" }));
    assert.deepEqual(messageLines(invalid), ["Paseo", "invalid", "config"]);
    assert.equal(invalid.retry, false);
    // C3b2: an unconfirmed close offers no Retry, only a plugin restart.
    const switchBlocked = slotKeyView(inputs({ connection: "switch_blocked" }));
    assert.deepEqual(messageLines(switchBlocked), ["Restart", "Paseo", "plugin"]);
    assert.equal(switchBlocked.retry, false);
    assert.equal(switchBlocked.identity, null);
  });

  it("marks stale, offline and failed data visibly while keeping the identity", () => {
    const stale = slotKeyView(inputs({ stale: true }));
    assert.equal(connection(stale), "stale");
    assert.deepEqual(stale.identity, TARGET);
    const offline = slotKeyView(inputs({ link: "reconnecting", stale: true }));
    assert.equal(connection(offline), "offline");
    assert.deepEqual(offline.identity, TARGET);
    assert.equal(connection(slotKeyView(inputs({ failure: "subscription_failed" }))), "error");
  });

  it("shows connection progress and errors before the first snapshot", () => {
    assert.deepEqual(
      messageLines(slotKeyView(inputs({ hasSnapshot: false, link: "connecting" }))),
      ["Paseo", "connecting"],
    );
    assert.deepEqual(
      messageLines(slotKeyView(inputs({ hasSnapshot: false, link: "disconnected" }))),
      ["Paseo", "not", "connected"],
    );
    const auth = slotKeyView(inputs({ hasSnapshot: false, recoveryError: "auth_failed" }));
    assert.deepEqual(messageLines(auth), ["Paseo", "error", "auth"]);
    assert.equal(auth.identity, null);
    const data = slotKeyView(inputs({ hasSnapshot: false, failure: "initial_snapshot_invalid" }));
    assert.deepEqual(messageLines(data), ["Paseo", "error", "bad data"]);
  });

  it("keeps every fixed English message line within one key line", () => {
    const cases: Partial<SlotInputs>[] = [
      { slot: "loading" },
      { connection: "loading" },
      { connection: "unavailable" },
      { connection: "invalid" },
      { hasSnapshot: false, link: "connecting" },
      { hasSnapshot: false, link: "disconnected" },
      ...(
        [
          "closed",
          "already_started",
          "connect_failed",
          "auth_failed",
          "host_identity_failed",
          "subscribe_failed",
          "subscription_failed",
          "initial_snapshot_invalid",
          "cleanup_failed",
          "start_timeout",
        ] as const
      ).flatMap((recoveryError) => [
        { hasSnapshot: false, recoveryError },
        { hasSnapshot: false, recoveryError, retryAvailable: true },
      ]),
    ];
    for (const overrides of cases) {
      const lines = messageLines(slotKeyView(inputs(overrides)));
      assert.ok(lines.length >= 1 && lines.length <= 3);
      for (const line of lines) {
        assert.ok(line.length <= 10, `"${line}" is longer than one key line`);
      }
    }
  });

  it("offers Retry only when the recovery owner accepts it", () => {
    const waiting = slotKeyView(
      inputs({ hasSnapshot: false, recoveryError: "connect_failed", retryAvailable: true }),
    );
    assert.equal(waiting.retry, true);
    assert.equal(waiting.identity, null);
    assert.deepEqual(messageLines(waiting), ["Paseo", "connect", "Retry"]);

    const failing = slotKeyView(inputs({ hasSnapshot: false, recoveryError: "connect_failed" }));
    assert.equal(failing.retry, false, "no Retry while the failed feed is still being closed");
    assert.equal(slotKeyView(inputs({ hasSnapshot: false, link: "connecting" })).retry, false);
    assert.equal(
      slotKeyView(inputs({ retryAvailable: true })).retry,
      false,
      "never on an agent key",
    );
    const badConfig = slotKeyView(
      inputs({
        connection: "invalid",
        recoveryError: "connect_failed",
        retryAvailable: true,
      }),
    );
    assert.equal(badConfig.retry, false, "a config problem is not retried");
    assert.equal(sameKeyView(waiting, failing), false);
  });

  it("treats views with the same content as equal", () => {
    assert.equal(sameKeyView(slotKeyView(inputs()), slotKeyView(inputs())), true);
    assert.equal(sameKeyView(slotKeyView(inputs()), slotKeyView(inputs({ stale: true }))), false);
    const finished = makeRecord({
      status: "idle",
      rawStatus: "idle",
      attentionReason: "finished",
      requiresAttention: true,
    });
    assert.equal(
      sameKeyView(slotKeyView(inputs()), slotKeyView(inputs({ record: finished }))),
      false,
    );
  });
});

describe("slotKeyView", () => {
  const record = makeRecord({ status: "running", rawStatus: "running" });
  const slot = (overrides: Partial<SlotInputs> = {}): KeyView =>
    slotKeyView({
      connection: "ok",
      link: "connected",
      stale: false,
      failure: null,
      recoveryError: null,
      retryAvailable: false,
      serverId: SERVER_ID,
      hasSnapshot: true,
      dimmed: false,
      slot: TARGET,
      record,
      ...overrides,
    });

  it("shows the placed agent and its identity", () => {
    const view = slot();
    assert.deepEqual(view.identity, TARGET);
    assert.equal(connection(view), "live");
    assert.equal(connection(slot({ link: "reconnecting" })), "offline");
  });

  it("shows nothing for an empty slot, a missing record or a mismatched identity", () => {
    for (const view of [
      slot({ slot: "empty" }),
      slot({ record: undefined }),
      slot({ slot: { serverId: SERVER_ID, agentId: "other" } }),
      slot({ serverId: "srv_Other" }),
    ]) {
      assert.equal(view.identity, null);
      assert.deepEqual(messageLines(view), []);
    }
  });

  it("shows loading, feed states and Retry", () => {
    assert.deepEqual(messageLines(slot({ slot: "loading" })), ["Loading"]);
    assert.deepEqual(messageLines(slot({ hasSnapshot: false, link: "connecting" })), [
      "Paseo",
      "connecting",
    ]);
    const retry = slot({ hasSnapshot: false, failure: "start_timeout", retryAvailable: true });
    assert.equal(retry.retry, true);
    // C3a3: a key shows the connection state, never a legacy E1 target.
    assert.deepEqual(messageLines(slot({ connection: "loading" })), ["Loading"]);
    assert.deepEqual(messageLines(slot({ connection: "unavailable" })), [
      "Paseo",
      "settings",
      "Retry",
    ]);
    assert.equal(slot({ connection: "unavailable" }).retry, true);
    assert.deepEqual(messageLines(slot({ connection: "invalid" })), ["Paseo", "invalid", "config"]);
    const switchBlocked = slot({ connection: "switch_blocked" });
    assert.deepEqual(messageLines(switchBlocked), ["Restart", "Paseo", "plugin"]);
    assert.equal(switchBlocked.retry, false);
  });
});
