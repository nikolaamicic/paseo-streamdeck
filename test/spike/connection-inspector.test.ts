import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SaveOutcome } from "../../src/connection/connection-saver.ts";
import {
  receivePage,
  reconnectPage,
  retryHandshake,
  savePage,
  startPage,
  type PageMessage,
  type PageState,
  type PluginMessage,
} from "../../src/inspector/connection-protocol.ts";
import {
  ConnectionInspectors,
  connectionStatusView,
} from "../../src/spike/connection-inspector.ts";
import type { ConnectionFacts } from "../../src/spike/feed-lifecycle.ts";
import { deferred } from "../support/fake-client.ts";

/**
 * The plugin's inspector controller (protocol v2, C4a4a) with fake pages
 * that are the shared page reducer, a Save the test settles and a wire the
 * test delivers. No SDK, runtime or lifecycle; the five SDK classes are in
 * the SDK harness, the runtime path in connection-save-runtime. A fake page
 * proves the protocol rules, not the real C4b page.
 */

const A = "ws://localhost:7001/ws";
const B = "ws://localhost:7002/ws";
const P1 = "page-nonce-000001";
const P2 = "page-nonce-000002";
const P3 = "page-nonce-000003";

const FACTS: ConnectionFacts = {
  view: { kind: "active", daemonUrl: A, source: "saved" },
  requested: { kind: "connect", daemonUrl: A, source: "saved" },
  saved: { kind: "ok", daemonUrl: A },
  sent: null,
  sending: null,
  link: "connecting",
  settingsRead: "idle",
};

/** One packet the controller handed to the SDK. */
interface Packet {
  readonly context: string;
  readonly message: PluginMessage;
}

function setup() {
  const wire: Packet[] = [];
  const logs: string[] = [];
  const saves: { raw: unknown; settle: (outcome: SaveOutcome) => void }[] = [];
  /** Sends the test holds: recorded on hand-over, settled later. */
  const held: { settle: (ok: boolean) => void }[] = [];
  let holdSends = false;
  let failSends = false;
  let facts: ConnectionFacts = FACTS;
  let challenges = 0;
  let reads = 0;
  /** What a read does synchronously, as the runtime's redraw would. */
  let onRead: () => void = () => undefined;
  const inspectors = new ConnectionInspectors({
    refreshSettings: () => {
      reads += 1;
      onRead();
    },
    save: (raw) => {
      const outcome = deferred<SaveOutcome>();
      saves.push({ raw, settle: outcome.resolve });
      return outcome.promise;
    },
    status: () => facts,
    send: (context, message) => {
      if (failSends) return Promise.reject(new Error("raw send error"));
      wire.push({ context, message });
      if (!holdSends) return Promise.resolve();
      const result = deferred<boolean>();
      held.push({ settle: result.resolve });
      return result.promise.then((ok) => {
        if (!ok) throw new Error("raw send error");
      });
    },
    newChallenge: () => {
      challenges += 1;
      return `challenge-${String(challenges).padStart(8, "0")}`;
    },
    log: (code) => logs.push(code),
  });
  const h = {
    inspectors,
    wire,
    logs,
    saves,
    held,
    holdSends: (on: boolean) => {
      holdSends = on;
    },
    reads: () => reads,
    onRead: (next: () => void) => {
      onRead = next;
    },
    failSends: (on: boolean) => {
      failSends = on;
    },
    setFacts: (next: ConnectionFacts) => {
      facts = next;
    },
    /** The packets of one context, from `from` on. */
    packets: (context: string, from = 0) =>
      wire.slice(from).filter((packet) => packet.context === context),
  };
  return h;
}

/**
 * A page instance as the shared reducer: it takes packets of its context
 * from the wire in order, and what it sends goes to the controller.
 */
class FakePage {
  state: PageState;
  private readonly h: ReturnType<typeof setup>;
  private readonly context: string;
  private delivered = 0;
  readonly sent: PageMessage[] = [];

  constructor(h: ReturnType<typeof setup>, context: string, pageNonce: string) {
    this.h = h;
    this.context = context;
    // A page that loaded later sees only what is sent from now on.
    this.delivered = h.wire.length;
    const start = startPage(context, pageNonce);
    this.state = start.state;
    if (start.send !== null) this.pending.push(start.send);
  }

  private readonly pending: PageMessage[] = [];

  /** Sends what the page has to say, then takes every new packet, until quiet. */
  async run(): Promise<void> {
    for (;;) {
      const next = this.pending.shift();
      if (next !== undefined) {
        this.sent.push(next);
        await this.h.inspectors.message(this.context, next);
        continue;
      }
      const packet = this.h.wire[this.delivered];
      if (packet === undefined) return;
      this.delivered += 1;
      if (packet.context !== this.context) continue;
      this.take(packet.message);
    }
  }

  /** One packet delivered to this page (also a held, old one). */
  take(message: unknown): void {
    const step = receivePage(this.state, message);
    this.state = step.state;
    if (step.send !== null) this.pending.push(step.send);
  }

  save(requestId: string, daemonUrl: string): void {
    const step = savePage(this.state, requestId, daemonUrl);
    this.state = step.state;
    if (step.send !== null) this.pending.push(step.send);
  }

  /** The state now (a call, so earlier assertions do not narrow it). */
  current(): PageState {
    return this.state;
  }

  /** The manual Retry of the waiting page: the same hello or confirm. */
  retry(): void {
    const step = retryHandshake(this.state);
    this.state = step.state;
    if (step.send !== null) this.pending.push(step.send);
  }

  reconnect(pageNonce: string): void {
    const step = reconnectPage(this.state, pageNonce);
    this.state = step.state;
    if (step.send !== null) this.pending.push(step.send);
  }

  /** Sends a raw message as this page would, bypassing the reducer (an old page's late message). */
  async raw(message: unknown): Promise<void> {
    await this.h.inspectors.message(this.context, message);
  }
}

/** Opens a generation and binds a page to it. */
async function opened(h: ReturnType<typeof setup>, context: string, pageNonce: string) {
  await h.inspectors.shown(context);
  const page = new FakePage(h, context, pageNonce);
  await page.run();
  assert.equal(page.state.kind, "bound", `${pageNonce} bound`);
  return page;
}

const challengeOf = (page: FakePage): string => {
  assert.ok(page.state.kind === "bound" || page.state.kind === "confirming");
  return page.state.challenge;
};

describe("ConnectionInspectors: binding", () => {
  it("appear sends only a ready; hello gets the challenge; the first confirm binds; status answers", async () => {
    const h = setup();
    await h.inspectors.shown("ctx");
    assert.deepEqual(h.wire, [
      { context: "ctx", message: { type: "connection_ready", context: "ctx" } },
    ]);
    const page = new FakePage(h, "ctx", P1);
    await page.run();
    assert.equal(page.state.kind, "bound");
    assert.deepEqual(
      h.packets("ctx").map((packet) => packet.message.type),
      ["connection_ready", "connection_challenge", "connection_bound"],
    );
    const c = challengeOf(page);
    await page.raw({ type: "connection_get_status", pageNonce: P1, challenge: c, requestId: "s1" });
    const last = h.wire.at(-1)?.message;
    assert.ok(last?.type === "connection_status");
    assert.deepEqual([last.pageNonce, last.challenge, last.seq, last.requestId], [P1, c, 2, "s1"]);
    assert.equal(h.saves.length, 0, "status never saves");
  });

  it("a hello before the appear is ignored; ready then brings the handshake", async () => {
    const h = setup();
    const page = new FakePage(h, "ctx", P1);
    await page.run();
    assert.deepEqual([h.wire.length, page.state.kind], [0, "awaiting"]);
    assert.ok(h.logs.includes("connection inspector: no_generation"));
    await h.inspectors.shown("ctx");
    await page.run();
    assert.equal(page.state.kind, "bound");
  });

  it("a repeated hello or confirm of the bound page is idempotent; no second binding", async () => {
    const h = setup();
    const page = await opened(h, "ctx", P1);
    const c = challengeOf(page);
    await page.raw({ type: "connection_hello", pageNonce: P1 });
    await page.raw({ type: "connection_confirm", pageNonce: P1, challenge: c });
    const resent = h.wire.slice(-2).map((packet) => packet.message);
    assert.deepEqual(
      resent.map((message) => [message.type, "seq" in message ? message.seq : null]),
      [
        ["connection_bound", 2],
        ["connection_bound", 3],
      ],
    );
    assert.equal(h.logs.filter((line) => line === "connection inspector: bound").length, 1);
  });

  it("a bound generation never rebinds: another page's hello or confirm is rejected", async () => {
    const h = setup();
    const first = await opened(h, "ctx", P1);
    const c = challengeOf(first);
    const second = new FakePage(h, "ctx", P2);
    await second.run();
    assert.deepEqual(second.state, { kind: "ended", context: "ctx", reason: "reopen_required" });
    await second.raw({ type: "connection_confirm", pageNonce: P2, challenge: c });
    const last = h.wire.at(-1)?.message;
    assert.ok(last?.type === "connection_rejected");
    assert.deepEqual([last.pageNonce, last.code], [P2, "generation_bound"]);
    // Reconnect cannot help here: it does nothing.
    second.reconnect(P3);
    assert.equal(second.state.kind, "ended");
    await first.raw({ type: "connection_get_status", pageNonce: P1, challenge: c, requestId: "s" });
    assert.equal(h.wire.at(-1)?.message.type, "connection_status", "the first stays bound");
  });
});

describe("ConnectionInspectors: manual Retry of a waiting page (C4a4a fix)", () => {
  it("a lost challenge: the page waits; Retry sends the same hello and binds once", async () => {
    const h = setup();
    await h.inspectors.shown("ctx");
    const page = new FakePage(h, "ctx", P1);
    h.failSends(true);
    await page.run();
    h.failSends(false);
    assert.equal(page.state.kind, "awaiting", "the challenge was never delivered");
    page.retry();
    await page.run();
    assert.equal(page.state.kind, "bound");
    assert.deepEqual(
      page.sent.map((message) => message.type),
      ["connection_hello", "connection_hello", "connection_confirm"],
    );
    assert.equal(h.logs.filter((line) => line === "connection inspector: bound").length, 1);
  });

  it("a lost bound: the plugin is bound, the page confirming; Retry sends the same confirm, no second binding, never another C", async () => {
    const h = setup();
    await h.inspectors.shown("ctx");
    const page = new FakePage(h, "ctx", P1);
    await page.raw({ type: "connection_hello", pageNonce: P1 });
    const offered = h.wire.at(-1)?.message;
    assert.ok(offered?.type === "connection_challenge");
    page.take(offered);
    assert.equal(page.state.kind, "confirming");
    // The confirm reaches the plugin, which binds; its bound is lost.
    h.failSends(true);
    await page.run();
    h.failSends(false);
    assert.equal(h.logs.filter((line) => line === "connection inspector: bound").length, 1);
    // A pushed status is ignored by the confirming page.
    h.setFacts({ ...FACTS, link: "connected" });
    h.inspectors.refresh();
    await page.run();
    assert.equal(page.state.kind, "confirming");
    // Another challenge never takes over.
    page.take({ ...offered, challenge: "challenge-99999999" });
    page.retry();
    await page.run();
    const final = page.current();
    assert.ok(final.kind === "bound" && final.challenge === offered.challenge);
    assert.equal(final.status.link, "connected");
    assert.equal(h.logs.filter((line) => line === "connection inspector: bound").length, 1);
    assert.equal(h.saves.length, 0, "no Save during the retry");
  });

  it("a Retry answered by a rejection keeps the ended and reopen contract", async () => {
    const h = setup();
    await opened(h, "ctx", P1);
    await h.inspectors.shown("other");
    const page = new FakePage(h, "ctx", P2);
    await page.run();
    assert.deepEqual(page.state, { kind: "ended", context: "ctx", reason: "reopen_required" });
    page.retry();
    await page.run();
    assert.equal(page.sent.length, 1, "no Retry from an ended page");
  });
});

describe("ConnectionInspectors: an old opening of the same context", () => {
  it("an old hello after a new bind, then an old Save: no rebind, no write", async () => {
    const h = setup();
    const old = await opened(h, "ctx", P1);
    const c1 = challengeOf(old);
    h.inspectors.hidden("ctx");
    const fresh = await opened(h, "ctx", P2);
    const c2 = challengeOf(fresh);
    await old.raw({ type: "connection_hello", pageNonce: P1 });
    const helloAnswer = h.wire.at(-1)?.message;
    assert.ok(helloAnswer?.type === "connection_rejected");
    assert.deepEqual([helloAnswer.pageNonce, helloAnswer.code], [P1, "generation_bound"]);
    await old.raw({
      type: "connection_save",
      pageNonce: P1,
      challenge: c1,
      requestId: "r-old",
      daemonUrl: B,
    });
    const saveAnswer = h.wire.at(-1)?.message;
    assert.ok(saveAnswer?.type === "connection_rejected");
    assert.deepEqual([saveAnswer.challenge, saveAnswer.code], [c1, "stale_session"]);
    // Also an old page with the new challenge cannot use the new binding.
    await old.raw({
      type: "connection_save",
      pageNonce: P1,
      challenge: c2,
      requestId: "r",
      daemonUrl: B,
    });
    assert.equal(h.saves.length, 0, "the saver is never called");
    await fresh.run();
    assert.equal(fresh.state.kind, "bound", "the new page is unaffected");
  });

  it("an old confirm with the old challenge in the new, unbound generation is rejected; the new page binds", async () => {
    const h = setup();
    const old = await opened(h, "ctx", P1);
    const c1 = challengeOf(old);
    h.inspectors.hidden("ctx");
    await h.inspectors.shown("ctx");
    await old.raw({ type: "connection_confirm", pageNonce: P1, challenge: c1 });
    const answer = h.wire.at(-1)?.message;
    assert.ok(answer?.type === "connection_rejected");
    assert.deepEqual([answer.challenge, answer.code], [c1, "stale_session"]);
    const fresh = new FakePage(h, "ctx", P2);
    await fresh.run();
    assert.equal(fresh.state.kind, "bound");
  });

  it("packets of the old binding already handed over reach the new page and are dropped, also with a reset seq", async () => {
    const h = setup();
    const old = await opened(h, "ctx", P1);
    const c1 = challengeOf(old);
    h.holdSends(true);
    const statusing = old.raw({
      type: "connection_get_status",
      pageNonce: P1,
      challenge: c1,
      requestId: "s",
    });
    h.setFacts({ ...FACTS, link: "connected" });
    h.inspectors.refresh();
    const heldPackets = h.wire.slice(-2).map((packet) => packet.message);
    h.inspectors.hidden("ctx");
    h.holdSends(false);
    const fresh = await opened(h, "ctx", P2);
    const before = fresh.state;
    for (const message of heldPackets) fresh.take(message);
    assert.deepEqual(fresh.state, before, "the old binding's packets change nothing");
    for (const entry of h.held) entry.settle(true);
    await statusing;
    assert.ok(fresh.state.kind === "bound" && fresh.state.seq === 1, "the own seq 1 counts");
  });

  it("two different challenges before bound: the page keeps the first; its stale confirm ends it, and a new nonce binds", async () => {
    const h = setup();
    await h.inspectors.shown("ctx");
    const page = new FakePage(h, "ctx", P1);
    await page.raw({ type: "connection_hello", pageNonce: P1 });
    // A second appear without a disappear: a new generation, a new challenge.
    await h.inspectors.shown("ctx");
    await page.raw({ type: "connection_hello", pageNonce: P1 });
    await page.run();
    assert.deepEqual(page.state, { kind: "ended", context: "ctx", reason: "session_reset" });
    assert.equal(page.sent.filter((message) => message.type === "connection_confirm").length, 1);
    page.reconnect(P2);
    await page.run();
    assert.equal(page.state.kind, "bound", "the new generation was unbound");
  });

  it("a late generation_bound for an earlier hello does not end the valid binding", async () => {
    const h = setup();
    const page = await opened(h, "ctx", P1);
    const before = page.state;
    page.take({
      type: "connection_rejected",
      context: "ctx",
      pageNonce: P1,
      challenge: null,
      request: "hello",
      requestId: null,
      code: "generation_bound",
    });
    assert.deepEqual(page.state, before);
  });
});

describe("ConnectionInspectors: Save, contexts and shutdown", () => {
  it("a bound Save calls save once and answers the latest request only", async () => {
    const h = setup();
    const page = await opened(h, "ctx", P1);
    page.save("r1", B);
    const saving = page.run();
    assert.equal(h.saves.length, 1);
    assert.equal(h.saves[0]?.raw, B);
    h.setFacts({ ...FACTS, sent: B });
    h.saves[0].settle({ kind: "sent" });
    await saving;
    assert.ok(page.state.kind === "bound");
    assert.deepEqual([page.state.lastSave?.outcome, page.state.status.sent], ["sent", B]);
  });

  it("an older Save's result is dropped whole at the page; the newer outcome stays", async () => {
    const h = setup();
    const page = await opened(h, "ctx", P1);
    page.save("r1", A);
    const first = page.run();
    page.save("r2", B);
    const second = page.run();
    assert.equal(h.saves.length, 2);
    h.saves[1]?.settle({ kind: "not_sent" });
    await second;
    h.saves[0]?.settle({ kind: "sent" });
    await first;
    await page.run();
    assert.ok(page.state.kind === "bound");
    assert.deepEqual(
      [page.state.lastSave?.requestId, page.state.lastSave?.outcome],
      ["r2", "not_sent"],
    );
  });

  it("two contexts bind and answer independently", async () => {
    const h = setup();
    const a = await opened(h, "a", P1);
    const b = await opened(h, "b", P2);
    a.save("ra", B);
    const saving = a.run();
    h.saves[0]?.settle({ kind: "sent" });
    await saving;
    await b.run();
    assert.ok(b.state.kind === "bound" && b.state.lastSave === null);
    assert.ok(a.state.kind === "bound" && a.state.lastSave?.requestId === "ra");
    assert.notEqual(challengeOf(a), challengeOf(b));
  });

  it("close in each pending phase: after the challenge, while confirming, and with a Save pending", async () => {
    const h = setup();
    await h.inspectors.shown("ctx");
    const page = new FakePage(h, "ctx", P1);
    await page.raw({ type: "connection_hello", pageNonce: P1 });
    h.inspectors.hidden("ctx");
    const marked = h.wire.length;
    await page.run();
    assert.equal(h.wire.length, marked, "a late confirm of a closed generation gets nothing");
    assert.equal(page.state.kind, "confirming");

    const bound = await opened(h, "ctx2", P2);
    bound.save("r1", B);
    const saving = bound.run();
    h.inspectors.hidden("ctx2");
    h.saves[0]?.settle({ kind: "sent" });
    await saving;
    assert.equal(h.saves.length, 1, "the accepted Save is not recalled");
    assert.ok(h.logs.includes("connection inspector: answer_dropped"));
    assert.ok(
      bound.state.kind === "bound" && bound.state.pendingSave === "r1",
      "no answer arrived",
    );
  });

  it("shutdown in each phase: nothing more is sent, saved or bound", async () => {
    const h = setup();
    const page = await opened(h, "ctx", P1);
    page.save("r1", B);
    const saving = page.run();
    await h.inspectors.shown("other");
    h.inspectors.dispose();
    h.saves[0]?.settle({ kind: "stopped" });
    await saving;
    const marked = h.wire.length;
    await h.inspectors.shown("ctx");
    const late = new FakePage(h, "other", P2);
    await late.run();
    h.inspectors.refresh();
    assert.equal(h.wire.length, marked);
    assert.equal(h.saves.length, 1);
  });

  it("a bad challenge from the generator opens nothing", async () => {
    const h = setup();
    const inspectors = new ConnectionInspectors({
      save: () => Promise.resolve({ kind: "stopped" }),
      status: () => FACTS,
      send: (context, message) => {
        h.wire.push({ context, message });
        return Promise.resolve();
      },
      newChallenge: () => "short",
      refreshSettings: () => {
        h.logs.push("read");
      },
      log: (code) => h.logs.push(code),
    });
    await inspectors.shown("ctx");
    await inspectors.message("ctx", { type: "connection_hello", pageNonce: P1 });
    assert.equal(h.wire.length, 0);
    assert.ok(h.logs.includes("connection inspector: bad_challenge"));
  });
});

describe("ConnectionInspectors: status pushes and the cache", () => {
  it("refresh pushes only a changed status to bound pages", async () => {
    const h = setup();
    const page = await opened(h, "ctx", P1);
    await h.inspectors.shown("unbound");
    const marked = h.wire.length;
    h.inspectors.refresh();
    assert.equal(h.wire.length, marked, "unchanged: nothing; unbound: nothing");
    h.setFacts({ ...FACTS, link: "connected" });
    h.inspectors.refresh();
    h.inspectors.refresh();
    await page.run();
    assert.equal(h.wire.length, marked + 1);
    assert.ok(page.state.kind === "bound" && page.state.status.link === "connected");
  });

  it("after a failed status send, the next refresh of the same status sends it again", async () => {
    const h = setup();
    const page = await opened(h, "ctx", P1);
    const c = challengeOf(page);
    h.setFacts({ ...FACTS, link: "connected" });
    h.failSends(true);
    await page.raw({ type: "connection_get_status", pageNonce: P1, challenge: c, requestId: "s" });
    h.failSends(false);
    const marked = h.wire.length;
    h.inspectors.refresh();
    assert.equal(h.wire.length, marked + 1, "sent again: the failed one was not cached");
    h.inspectors.refresh();
    assert.equal(h.wire.length, marked + 1, "now cached");
    assert.ok(h.logs.includes("connection inspector: send_failed"));
    assert.equal(h.logs.join("\n").includes("raw"), false);
  });

  it("a late failure of an older status send leaves the newer one cached", async () => {
    const h = setup();
    const page = await opened(h, "ctx", P1);
    const c = challengeOf(page);
    const ask = (requestId: string) =>
      page.raw({ type: "connection_get_status", pageNonce: P1, challenge: c, requestId });
    h.holdSends(true);
    h.setFacts({ ...FACTS, link: "connected" });
    const older = ask("s1");
    h.setFacts({ ...FACTS, link: "reconnecting" });
    const newer = ask("s2");
    h.holdSends(false);
    h.held[1]?.settle(true);
    h.held[0]?.settle(false);
    await newer;
    await older;
    const marked = h.wire.length;
    h.inspectors.refresh();
    assert.equal(h.wire.length, marked, "the newer status is still the cached one");
  });

  it("connectionStatusView keeps the facts apart; connected only from the link", () => {
    const view = connectionStatusView({ ...FACTS, view: { kind: "switch_blocked" }, link: "none" });
    assert.deepEqual([view.view, view.active, view.link], ["switch_blocked", null, "none"]);
  });
});

describe("ConnectionInspectors: one settings read per binding (C4a4b)", () => {
  it("only a successful bind reads, exactly once; repeats, retries and refusals never read", async () => {
    const h = setup();
    const early = new FakePage(h, "ctx", P1);
    await early.run();
    assert.equal(h.reads(), 0, "a hello before the appear does not read");
    await h.inspectors.shown("ctx");
    assert.equal(h.reads(), 0, "an appearance does not read");
    await early.raw({ type: "connection_confirm", pageNonce: P1, challenge: "challenge-99999999" });
    assert.equal(h.reads(), 0, "an invalid confirm does not read");
    await early.run();
    assert.equal(early.state.kind, "bound");
    assert.equal(h.reads(), 1, "the bind reads once");
    const c = challengeOf(early);
    await early.raw({ type: "connection_hello", pageNonce: P1 });
    await early.raw({ type: "connection_confirm", pageNonce: P1, challenge: c });
    const other = new FakePage(h, "ctx", P2);
    await other.run();
    assert.equal(h.reads(), 1, "repeats and another page's hello do not read");
    h.inspectors.hidden("ctx");
    await early.raw({ type: "connection_confirm", pageNonce: P1, challenge: c });
    h.inspectors.dispose();
    await h.inspectors.shown("ctx");
    assert.equal(h.reads(), 1, "closed and shut down: no read");
  });

  it("a manual Retry that recovers a lost bound reads nothing again", async () => {
    const h = setup();
    await h.inspectors.shown("ctx");
    const page = new FakePage(h, "ctx", P1);
    await page.raw({ type: "connection_hello", pageNonce: P1 });
    const offered = h.wire.at(-1)?.message;
    assert.ok(offered?.type === "connection_challenge");
    page.take(offered);
    h.failSends(true);
    await page.run();
    h.failSends(false);
    assert.equal(h.reads(), 1);
    page.retry();
    await page.run();
    assert.equal(page.current().kind, "bound");
    assert.equal(h.reads(), 1);
  });

  it("the read's synchronous redraw follows the bound: the page ends on the read's status", async () => {
    const h = setup();
    h.onRead(() => {
      h.setFacts({ ...FACTS, settingsRead: "pending" });
      h.inspectors.refresh();
    });
    const page = await opened(h, "ctx", P1);
    const types = h.packets("ctx").map((packet) => packet.message.type);
    assert.deepEqual(types.slice(-2), ["connection_bound", "connection_status"]);
    const state = page.current();
    assert.ok(state.kind === "bound");
    assert.equal(state.status.settingsRead, "pending");
    assert.deepEqual(state.status, connectionStatusView({ ...FACTS, settingsRead: "pending" }));
  });

  it("when the bound and the read's push are both lost, Retry brings the current status", async () => {
    const h = setup();
    h.onRead(() => {
      h.setFacts({ ...FACTS, settingsRead: "pending" });
      h.inspectors.refresh();
    });
    await h.inspectors.shown("ctx");
    const page = new FakePage(h, "ctx", P1);
    await page.raw({ type: "connection_hello", pageNonce: P1 });
    const offered = h.wire.at(-1)?.message;
    assert.ok(offered?.type === "connection_challenge");
    page.take(offered);
    h.failSends(true);
    await page.run();
    h.failSends(false);
    page.retry();
    await page.run();
    const state = page.current();
    assert.ok(state.kind === "bound" && state.status.settingsRead === "pending");
    assert.equal(h.reads(), 1);
  });
});
