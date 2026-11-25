import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isConnectionMessage,
  parsePageMessage,
  parsePluginMessage,
  receivePage,
  parseStatusView,
  reconnectPage,
  retryHandshake,
  savePage,
  startPage,
  type ConnectionStatusView,
  type PageState,
} from "../../src/inspector/connection-protocol.ts";

/**
 * Protocol v2 (C4a4a) as pure functions: both validators and the page
 * reducer a future inspector page (C4b) uses. A fake page here is only this
 * reducer; it proves the rules, not a real UI.
 */

const P1 = "page-nonce-000001";
const P2 = "page-nonce-000002";
const C1 = "challenge-0000001";
const C2 = "challenge-0000002";
const CTX = "ctx";

const STATUS: ConnectionStatusView = {
  view: "active",
  blockedReason: null,
  active: { daemonUrl: "ws://localhost:7001/ws", source: "saved" },
  requested: { kind: "connect", daemonUrl: "ws://localhost:7001/ws", reason: null },
  saved: { kind: "ok", daemonUrl: "ws://localhost:7001/ws", error: null },
  sent: null,
  sending: null,
  link: "connected",
  settingsRead: "idle",
};
const OTHER: ConnectionStatusView = { ...STATUS, link: "reconnecting" };

const challenge = (pageNonce: string, c: string, context = CTX) => ({
  type: "connection_challenge",
  context,
  pageNonce,
  challenge: c,
});
const bound = (pageNonce: string, c: string, seq: number, status = STATUS) => ({
  type: "connection_bound",
  context: CTX,
  pageNonce,
  challenge: c,
  seq,
  status,
});
const status = (pageNonce: string, c: string, seq: number, s = STATUS) => ({
  type: "connection_status",
  context: CTX,
  pageNonce,
  challenge: c,
  seq,
  requestId: null,
  status: s,
});
const result = (
  pageNonce: string,
  c: string,
  seq: number,
  requestId: string,
  outcome = "sent",
) => ({
  type: "connection_save_result",
  context: CTX,
  pageNonce,
  challenge: c,
  seq,
  requestId,
  outcome,
  error: null,
  status: OTHER,
});
const rejected = (pageNonce: string, c: string | null, code: string, request = "hello") => ({
  type: "connection_rejected",
  context: CTX,
  pageNonce,
  challenge: c,
  request,
  requestId: null,
  code,
});

/** Feeds messages to a page in order; returns its state and what it sent. */
function feed(state: PageState, ...messages: unknown[]) {
  const sent: unknown[] = [];
  let current = state;
  for (const message of messages) {
    const step = receivePage(current, message);
    current = step.state;
    if (step.send !== null) sent.push(step.send);
  }
  return { state: current, sent };
}

function boundPage(): PageState {
  const { state } = feed(startPage(CTX, P1).state, challenge(P1, C1), bound(P1, C1, 1));
  assert.equal(state.kind, "bound");
  return state;
}

describe("protocol validators", () => {
  it("only a connection_ type is a connection message; Start in messages are not", () => {
    assert.equal(isConnectionMessage({ type: "connection_hello" }), true);
    assert.equal(isConnectionMessage({ type: "connection_anything" }), true);
    for (const other of [{ type: "choose", value: "x" }, { type: "refresh" }, null, "x", []]) {
      assert.equal(isConnectionMessage(other), false);
    }
  });

  it("page messages: exact kinds, keys and lengths; the address is left raw", () => {
    assert.deepEqual(parsePageMessage({ type: "connection_hello", pageNonce: P1 }), {
      type: "connection_hello",
      pageNonce: P1,
    });
    assert.deepEqual(
      parsePageMessage({
        type: "connection_save",
        pageNonce: P1,
        challenge: C1,
        requestId: "r1",
        daemonUrl: 42,
      }),
      { type: "connection_save", pageNonce: P1, challenge: C1, requestId: "r1", daemonUrl: 42 },
    );
    const bad: unknown[] = [
      { type: "connection_hello", pageNonce: "short" },
      { type: "connection_hello", pageNonce: "x".repeat(65) },
      { type: "connection_hello", pageNonce: `${P1} ` },
      { type: "connection_hello", pageNonce: P1, extra: 1 },
      { type: "connection_confirm", pageNonce: P1 },
      { type: "connection_confirm", pageNonce: P1, challenge: "short" },
      { type: "connection_get_status", pageNonce: P1, challenge: C1 },
      { type: "connection_get_status", pageNonce: P1, challenge: C1, requestId: "" },
      { type: "connection_save", pageNonce: P1, challenge: C1, requestId: "r" },
      { type: "connection_status", pageNonce: P1, challenge: C1, requestId: "r" },
      { type: "connection_unknown", pageNonce: P1 },
      [P1],
    ];
    for (const payload of bad)
      assert.equal(parsePageMessage(payload), null, JSON.stringify(payload));
  });

  it("plugin messages: seq is a finite safe positive integer; the status view is strict", () => {
    assert.ok(parsePluginMessage(bound(P1, C1, 1)));
    assert.ok(parsePluginMessage(bound(P1, C1, Number.MAX_SAFE_INTEGER)));
    for (const seq of [0, -1, 1.5, Infinity, Number.NaN, 2 ** 53, "1"]) {
      assert.equal(parsePluginMessage({ ...bound(P1, C1, 1), seq }), null);
    }
    const broken: unknown[] = [
      { ...bound(P1, C1, 1), extra: 1 },
      { ...bound(P1, C1, 1), status: { ...STATUS, link: 1 } },
      { ...bound(P1, C1, 1), status: { ...STATUS, extra: 1 } },
      { ...bound(P1, C1, 1), status: { ...STATUS, active: { daemonUrl: "x" } } },
      { ...status(P1, C1, 2), requestId: "" },
      { ...result(P1, C1, 2, "r"), outcome: 1 },
      { ...rejected(P1, null, "generation_bound"), code: "other" },
      { ...rejected(P1, null, "generation_bound"), request: "other" },
      { ...challenge(P1, C1), context: "" },
      { type: "connection_ready", context: CTX, extra: 1 },
    ];
    for (const payload of broken)
      assert.equal(parsePluginMessage(payload), null, JSON.stringify(payload));
  });
});

describe("the page reducer", () => {
  it("a full handshake: hello, the challenge chosen before the confirm, then bound", () => {
    const start = startPage(CTX, P1);
    assert.deepEqual(start.send, { type: "connection_hello", pageNonce: P1 });
    const confirming = receivePage(start.state, challenge(P1, C1));
    assert.deepEqual(confirming.state, {
      kind: "confirming",
      context: CTX,
      pageNonce: P1,
      challenge: C1,
    });
    assert.deepEqual(confirming.send, {
      type: "connection_confirm",
      pageNonce: P1,
      challenge: C1,
    });
    const after = receivePage(confirming.state, bound(P1, C1, 1));
    assert.equal(after.state.kind, "bound");
    assert.equal(after.send, null);
  });

  it("one P confirms at most one C: a second challenge before bound is ignored, and bound only for the chosen C", () => {
    const { state, sent } = feed(
      startPage(CTX, P1).state,
      challenge(P1, C1),
      challenge(P1, C2),
      bound(P1, C2, 1),
    );
    assert.deepEqual(state, { kind: "confirming", context: CTX, pageNonce: P1, challenge: C1 });
    assert.equal(sent.length, 1, "one confirm only");
    assert.equal(feed(state, bound(P1, C1, 1)).state.kind, "bound");
  });

  it("the same challenge again changes neither a confirming nor a bound page", () => {
    const confirming = feed(startPage(CTX, P1).state, challenge(P1, C1));
    assert.deepEqual(feed(confirming.state, challenge(P1, C1)), {
      state: confirming.state,
      sent: [],
    });
    const page = boundPage();
    assert.deepEqual(feed(page, challenge(P1, C1)), { state: page, sent: [] });
  });

  it("messages of another nonce, challenge or context are ignored", () => {
    const page = boundPage();
    for (const message of [
      status(P2, C1, 2, OTHER),
      status(P1, C2, 2, OTHER),
      { ...status(P1, C1, 2, OTHER), context: "other" },
      challenge(P1, C2),
    ]) {
      assert.deepEqual(receivePage(page, message).state, page);
    }
  });

  it("an old binding's packets are rejected even with a reset seq; the own seq orders the view", () => {
    const page = feed(startPage(CTX, P2).state, challenge(P2, C2), bound(P2, C2, 1)).state;
    // Held packets of the old binding (P1, C1) with seq 1 and 2.
    assert.deepEqual(feed(page, status(P1, C1, 1, OTHER), result(P1, C1, 2, "r")).state, page);
    const newer = feed(page, status(P2, C2, 2, OTHER)).state;
    assert.ok(newer.kind === "bound" && newer.status.link === "reconnecting");
    assert.deepEqual(feed(newer, status(P2, C2, 2, STATUS)).state, newer, "seq not higher");
  });

  it("a late generation_bound for a hello does not end a valid binding; a rejection of its own C does", () => {
    const page = boundPage();
    assert.deepEqual(receivePage(page, rejected(P1, null, "generation_bound")).state, page);
    assert.deepEqual(receivePage(page, rejected(P1, C1, "stale_session", "get_status")).state, {
      kind: "ended",
      context: CTX,
      reason: "session_reset",
    });
  });

  it("generation_bound while awaiting needs a reopen: Reconnect does nothing then", () => {
    const ended = feed(startPage(CTX, P1).state, rejected(P1, null, "generation_bound")).state;
    assert.deepEqual(ended, { kind: "ended", context: CTX, reason: "reopen_required" });
    assert.deepEqual(reconnectPage(ended, P2), { state: ended, send: null });
  });

  it("a ready while bound ends the binding (a possible needless reopen); Reconnect then uses a new nonce", () => {
    const ended = receivePage(boundPage(), { type: "connection_ready", context: CTX }).state;
    assert.deepEqual(ended, { kind: "ended", context: CTX, reason: "session_reset" });
    const again = reconnectPage(ended, P2);
    assert.deepEqual(again.send, { type: "connection_hello", pageNonce: P2 });
    assert.equal(again.state.kind, "awaiting");
    assert.equal(receivePage(ended, bound(P1, C1, 9)).state, ended, "ended takes nothing");
  });

  it("a ready while awaiting says hello again; nothing else ever sends a Save", () => {
    const step = receivePage(startPage(CTX, P1).state, { type: "connection_ready", context: CTX });
    assert.deepEqual(step.send, { type: "connection_hello", pageNonce: P1 });
    assert.deepEqual(savePage(startPage(CTX, P1).state, "r1", "ws://x"), {
      state: startPage(CTX, P1).state,
      send: null,
    });
  });

  it("only the latest Save's result counts; an older one is dropped whole", () => {
    let page = savePage(boundPage(), "r1", "ws://localhost:1/ws").state;
    page = savePage(page, "r2", "ws://localhost:2/ws").state;
    const older = receivePage(page, result(P1, C1, 5, "r1"));
    assert.deepEqual(older.state, page, "neither its seq nor its status");
    const newest = receivePage(page, result(P1, C1, 2, "r2", "not_sent")).state;
    assert.ok(newest.kind === "bound");
    assert.deepEqual(
      [newest.pendingSave, newest.lastSave?.outcome, newest.seq],
      [null, "not_sent", 2],
    );
    assert.equal(newest.status.link, "reconnecting");
    assert.deepEqual(receivePage(newest, result(P1, C1, 3, "r2")).state, newest, "answered once");
  });

  it("retryHandshake resends the same hello or the same confirm, and does nothing once bound or ended", () => {
    const awaiting = startPage(CTX, P1).state;
    assert.deepEqual(retryHandshake(awaiting), {
      state: awaiting,
      send: { type: "connection_hello", pageNonce: P1 },
    });
    const confirming = receivePage(awaiting, challenge(P1, C1)).state;
    assert.deepEqual(retryHandshake(confirming), {
      state: confirming,
      send: { type: "connection_confirm", pageNonce: P1, challenge: C1 },
    });
    const page = boundPage();
    assert.deepEqual(retryHandshake(page), { state: page, send: null });
    const ended = receivePage(page, { type: "connection_ready", context: CTX }).state;
    assert.deepEqual(retryHandshake(ended), { state: ended, send: null });
  });
});

describe("strict status domains (C4a4a fix)", () => {
  const view = (changes: Record<string, unknown>) => ({ ...STATUS, ...changes });

  it("invented codes are refused everywhere", () => {
    assert.equal(
      parseStatusView({
        view: "invented",
        blockedReason: null,
        active: null,
        requested: { kind: "invented", daemonUrl: null, reason: null },
        saved: { kind: "invented", daemonUrl: null, error: null },
        sent: null,
        sending: null,
        link: "invented",
        settingsRead: "invented",
      }),
      null,
    );
    for (const changes of [
      { settingsRead: "invented" },
      { settingsRead: null },
      { link: "invented" },
      { active: { daemonUrl: "ws://localhost:1/ws", source: "invented" } },
      { view: "blocked", active: null, blockedReason: "invented" },
      { requested: { kind: "blocked", daemonUrl: null, reason: "invented" } },
      { saved: { kind: "invalid", daemonUrl: null, error: "invented" } },
      { saved: { kind: "invented", daemonUrl: null, error: null } },
    ]) {
      assert.equal(parseStatusView(view(changes)), null, JSON.stringify(changes));
    }
  });

  it("wrong combinations of the discriminators are refused", () => {
    for (const changes of [
      { active: null },
      { view: "loading" },
      { view: "blocked", blockedReason: null, active: null },
      { view: "loading", active: null, blockedReason: "saved_invalid" },
      { requested: { kind: "connect", daemonUrl: null, reason: null } },
      { requested: { kind: "blocked", daemonUrl: "ws://localhost:1/ws", reason: "saved_invalid" } },
      { requested: { kind: "loading", daemonUrl: null, reason: "saved_invalid" } },
      { saved: { kind: "ok", daemonUrl: null, error: null } },
      { saved: { kind: "invalid", daemonUrl: null, error: null } },
      { saved: { kind: "absent", daemonUrl: "ws://localhost:1/ws", error: null } },
    ]) {
      assert.equal(parseStatusView(view(changes)), null, JSON.stringify(changes));
    }
    const blocked = parseStatusView(
      view({ view: "blocked", active: null, blockedReason: "legacy_invalid_target_only" }),
    );
    assert.ok(blocked !== null && blocked.blockedReason === "legacy_invalid_target_only");
  });

  it("a Save result carries a known outcome, and an address error exactly with invalid", () => {
    assert.equal(parsePluginMessage({ ...result(P1, C1, 2, "r"), outcome: "invented" }), null);
    assert.equal(parsePluginMessage({ ...result(P1, C1, 2, "r"), outcome: "invalid" }), null);
    assert.equal(parsePluginMessage({ ...result(P1, C1, 2, "r"), error: "invalid_format" }), null);
    assert.equal(
      parsePluginMessage({ ...result(P1, C1, 2, "r", "invalid"), error: "invented" }),
      null,
    );
    assert.ok(
      parsePluginMessage({ ...result(P1, C1, 2, "r", "invalid"), error: "invalid_format" }),
    );
  });
});
