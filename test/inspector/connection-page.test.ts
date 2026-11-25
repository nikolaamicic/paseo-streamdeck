import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SaveOutcome } from "../../src/connection/connection-saver.ts";
import type {
  PageMessage,
  PluginMessage,
  StatusBlockReason,
} from "../../src/inspector/connection-protocol.ts";
import {
  ConnectionPage,
  detailLines,
  outcomeText,
  SAVE_ANSWER_TIMEOUT_MS,
  statusText,
  type PageView,
} from "../../src/inspector/page/connection-page.ts";
import {
  ConnectionInspectors,
  connectionStatusView,
} from "../../src/spike/connection-inspector.ts";
import type { ConnectionFacts } from "../../src/spike/feed-lifecycle.ts";
import { deferred, ManualScheduler } from "../support/fake-client.ts";

/**
 * The inspector page controller (C4b) paired with the real plugin-side
 * ConnectionInspectors over an in-memory wire, plus synthetic packets. No
 * DOM: a recording view. It proves the page's rules over the shared
 * reducer, not a real webview or Stream Deck.
 */

const A = "ws://127.0.0.1:6767/ws";
const B = "ws://localhost:7002/ws";

const FACTS: ConnectionFacts = {
  view: { kind: "active", daemonUrl: A, source: "saved" },
  requested: { kind: "connect", daemonUrl: A, source: "saved" },
  saved: { kind: "ok", daemonUrl: A },
  sent: null,
  sending: null,
  link: "connecting",
  settingsRead: "idle",
};

/** The view as the user sees it now. */
class RecordingView implements PageView {
  status = "";
  details: readonly string[] = [];
  message = "";
  recovery: "none" | "retry" | "reconnect" = "none";
  input = "";
  saveEnabled = false;
  inputWrites = 0;
  setStatus(text: string): void {
    this.status = text;
  }
  setDetails(lines: readonly string[]): void {
    this.details = lines;
  }
  setMessage(text: string): void {
    this.message = text;
  }
  setRecovery(kind: "none" | "retry" | "reconnect"): void {
    this.recovery = kind;
  }
  setInput(value: string): void {
    this.input = value;
    this.inputWrites += 1;
  }
  setSaveEnabled(enabled: boolean): void {
    this.saveEnabled = enabled;
  }
  snapshot() {
    const { status, details, message, recovery, input, saveEnabled } = this;
    return { status, details, message, recovery, input, saveEnabled };
  }
}

function pair() {
  const clock = new ManualScheduler();
  const view = new RecordingView();
  const toPlugin: PageMessage[] = [];
  const toPage: PluginMessage[] = [];
  const sentToPlugin: PageMessage[] = [];
  /** Save requests the plugin is answering; settled by answer(). */
  const inflight: Promise<void>[] = [];
  const saves: { raw: unknown; settle: (outcome: SaveOutcome) => void }[] = [];
  let facts: ConnectionFacts = FACTS;
  let open = true;
  /** Drops the next plugin message of this type (a lost packet). */
  const drops: string[] = [];
  let challenges = 0;
  let nonces = 0;
  const plugin = new ConnectionInspectors({
    save: (raw) => {
      const outcome = deferred<SaveOutcome>();
      saves.push({ raw, settle: outcome.resolve });
      return outcome.promise;
    },
    status: () => facts,
    send: (_context, message) => {
      const index = drops.indexOf(message.type);
      if (index >= 0) {
        drops.splice(index, 1);
        return Promise.resolve();
      }
      toPage.push(message);
      return Promise.resolve();
    },
    newChallenge: () => {
      challenges += 1;
      return `challenge-${String(challenges).padStart(8, "0")}`;
    },
    refreshSettings: () => undefined,
    log: () => undefined,
  });
  const page = new ConnectionPage({
    context: "ctx",
    view,
    transport: {
      send: (message) => {
        if (!open) return false;
        toPlugin.push(message);
        return true;
      },
    },
    newNonce: () => {
      nonces += 1;
      return `page-nonce-${String(nonces).padStart(6, "0")}`;
    },
    after: (delayMs, callback) => clock.after(delayMs, callback),
  });
  const h = {
    clock,
    view,
    page,
    plugin,
    saves,
    toPlugin,
    sentToPlugin,
    inflight,
    setFacts: (next: ConnectionFacts) => {
      facts = next;
    },
    close: () => {
      open = false;
    },
    drop: (type: PluginMessage["type"]) => {
      drops.push(type);
    },
    /** Delivers both directions until quiet; every plugin call is awaited. */
    pump: async () => {
      for (;;) {
        const up = toPlugin.shift();
        if (up !== undefined) {
          sentToPlugin.push(up);
          const handled = plugin.message("ctx", up);
          // A Save waits for the test's answer; everything else completes now.
          if (up.type === "connection_save") inflight.push(handled);
          else await handled;
          continue;
        }
        const down = toPage.shift();
        if (down === undefined) return;
        page.receive(down);
      }
    },
    /** Settles the plugin's Save `index` and delivers its answer. */
    answer: async (index: number, outcome: SaveOutcome) => {
      const save = saves[index];
      assert.ok(save);
      save.settle(outcome);
      await inflight[index];
      await h.pump();
    },
    /**
     * Opens the inspector, then loads the page: its ready went out before
     * the page listened, as for a page that loads after the appearance.
     */
    open: async () => {
      await plugin.shown("ctx");
      toPage.length = 0;
      page.start();
    },
    bound: async () => {
      await h.open();
      await h.pump();
    },
    savesSent: () => h.sentToPlugin.filter((message) => message.type === "connection_save"),
  };
  return h;
}

describe("ConnectionPage: boot and Save", () => {
  it("boots through hello, confirm and bound; only then is Save enabled and the field filled once", async () => {
    const h = pair();
    await h.open();
    assert.equal(h.view.status, "Waiting for the plugin…");
    assert.equal(h.view.saveEnabled, false);
    assert.equal(h.view.recovery, "retry");
    await h.pump();
    assert.deepEqual(
      h.sentToPlugin.map((message) => message.type),
      ["connection_hello", "connection_confirm"],
    );
    assert.equal(h.view.status, `Connecting to ${A}…`, "active, not connected yet");
    assert.deepEqual([h.view.saveEnabled, h.view.recovery, h.view.input], [true, "none", A]);
    h.setFacts({ ...FACTS, link: "connected" });
    h.plugin.refresh();
    await h.pump();
    assert.equal(h.view.status, `Connected to Paseo at ${A}.`);
    assert.equal(h.view.inputWrites, 1, "filled once");
  });

  it("a Save is sent exactly once; a second click while it waits sends nothing", async () => {
    const h = pair();
    await h.bound();
    h.page.inputChanged(B);
    h.page.save();
    h.page.save();
    await h.pump();
    assert.equal(h.savesSent().length, 1);
    assert.equal(h.saves.length, 1);
    assert.equal(h.view.saveEnabled, false);
    assert.equal(h.view.message, "Sending…");
    h.setFacts({ ...FACTS, saved: { kind: "ok", daemonUrl: B }, sent: B });
    await h.answer(0, { kind: "sent" });
    assert.equal(h.view.message, "Sent to Stream Deck.");
    assert.equal(h.view.saveEnabled, true);
  });

  it("a status push while a second Save waits is not its answer, even after an earlier answer", async () => {
    const h = pair();
    await h.bound();
    h.page.inputChanged(B);
    h.page.save();
    await h.pump();
    await h.answer(0, { kind: "sent" });
    assert.equal(h.view.message, "Sent to Stream Deck.");
    h.page.inputChanged("ws://localhost:7003/ws");
    h.page.save();
    await h.pump();
    h.setFacts({ ...FACTS, link: "connected" });
    h.plugin.refresh();
    await h.pump();
    assert.equal(h.view.message, "Sending…", "only the correlated answer ends this Save");
    assert.equal(h.view.saveEnabled, false);
    await h.answer(1, { kind: "not_sent" });
    assert.equal(h.view.message, "The request was not sent to Stream Deck.");
  });

  it("Retry on a bound page with a draft sends nothing", async () => {
    const h = pair();
    await h.bound();
    h.page.inputChanged(B);
    const before = h.toPlugin.length + h.sentToPlugin.length;
    h.page.retry();
    await h.pump();
    assert.equal(h.savesSent().length, 0);
    assert.equal(h.toPlugin.length + h.sentToPlugin.length, before);
  });

  it("the handshake Retry never sends a Save; Save before bound does nothing", async () => {
    const h = pair();
    h.page.inputChanged(B);
    h.page.save();
    await h.open();
    h.page.retry();
    await h.pump();
    assert.equal(h.savesSent().length, 0);
    assert.equal(h.saves.length, 0);
  });
});

describe("ConnectionPage: the address field", () => {
  it("a status push never overwrites an edit", async () => {
    const h = pair();
    await h.bound();
    h.page.inputChanged("ws://localhost:9/w");
    h.setFacts({ ...FACTS, saved: { kind: "ok", daemonUrl: B } });
    h.plugin.refresh();
    await h.pump();
    assert.equal(h.view.input, A, "the field shows what the page last filled, not the push");
    assert.equal(h.view.inputWrites, 1);
  });

  it("an edit while the Save waits, also back to the same text, is kept after its answer", async () => {
    const h = pair();
    await h.bound();
    h.page.inputChanged(B);
    h.page.save();
    await h.pump();
    h.page.inputChanged("x");
    h.page.inputChanged(B);
    h.setFacts({ ...FACTS, saved: { kind: "ok", daemonUrl: B } });
    await h.answer(0, { kind: "sent" });
    assert.equal(h.view.message, "Sent to Stream Deck.");
    assert.equal(h.view.inputWrites, 1, "not refilled: the user edited meanwhile");
  });

  it("without an edit, the field shows what is saved after the answer, also a newer setting", async () => {
    const h = pair();
    await h.bound();
    h.page.inputChanged(B);
    h.page.save();
    await h.pump();
    h.setFacts({ ...FACTS, saved: { kind: "ok", daemonUrl: "ws://localhost:7003/ws" } });
    await h.answer(0, { kind: "sent" });
    const result = h.sentToPlugin.length;
    assert.ok(result > 0);
    assert.equal(h.view.input, "ws://localhost:7003/ws");
  });

  it("an invalid or unsent Save keeps the typed text for a correction", async () => {
    for (const outcome of [
      { kind: "invalid", error: "invalid_format" },
      { kind: "not_sent" },
    ] as const) {
      const h = pair();
      await h.bound();
      h.page.inputChanged("ws://example.com:1/ws");
      h.page.save();
      await h.pump();
      await h.answer(0, outcome);
      assert.equal(h.view.inputWrites, 1, outcome.kind);
      assert.equal(
        h.view.message,
        outcomeText(outcome.kind, "error" in outcome ? outcome.error : null),
      );
      assert.equal(h.view.saveEnabled, true);
    }
  });

  it("the field starts with the saved address when the active one differs", async () => {
    const h = pair();
    h.setFacts({
      ...FACTS,
      view: { kind: "switch_blocked" },
      saved: { kind: "ok", daemonUrl: B },
      link: "none",
    });
    await h.bound();
    assert.equal(h.view.input, B);
    assert.equal(
      h.view.status,
      "Could not confirm the previous connection closed. Restart the plugin.",
    );
    assert.deepEqual(h.view.details, [`Saved address: ${B} (not in use).`]);
  });

  it("a draft survives a reset and Reconnect", async () => {
    const h = pair();
    await h.bound();
    h.page.inputChanged("draft");
    // A second appearance: a new generation, the binding is reset.
    await h.plugin.shown("ctx");
    await h.pump();
    assert.equal(h.view.recovery, "reconnect");
    h.page.reconnect();
    await h.pump();
    assert.equal(h.view.saveEnabled, true, "bound again with a new nonce");
    assert.equal(h.view.inputWrites, 1, "the draft is not replaced");
  });
});

describe("ConnectionPage: lost, late and failed", () => {
  it("a lost challenge or bound: the page waits with Retry, and Retry binds", async () => {
    for (const lost of ["connection_challenge", "connection_bound"] as const) {
      const h = pair();
      h.drop(lost);
      await h.bound();
      assert.equal(h.view.status, "Waiting for the plugin…", lost);
      assert.equal(h.view.recovery, "retry");
      h.page.retry();
      await h.pump();
      assert.equal(h.view.saveEnabled, true, lost);
      assert.equal(h.savesSent().length, 0);
    }
  });

  it("a Save without an answer becomes unknown after 5 s, is not repeated, and a late answer still counts", async () => {
    const h = pair();
    await h.bound();
    h.page.inputChanged(B);
    h.page.save();
    await h.pump();
    h.clock.advance(SAVE_ANSWER_TIMEOUT_MS - 1);
    assert.equal(h.view.message, "Sending…");
    h.clock.advance(1);
    assert.match(h.view.message, /outcome of this Save is unknown/);
    assert.equal(h.view.saveEnabled, true, "the user may Save again explicitly");
    assert.equal(h.savesSent().length, 1, "never repeated by itself");
    await h.answer(0, { kind: "sent" });
    assert.equal(h.view.message, "Sent to Stream Deck.");
  });

  it("an older Save's late answer or an old binding's packet changes nothing", async () => {
    const h = pair();
    await h.bound();
    h.page.inputChanged(B);
    h.page.save();
    await h.pump();
    h.clock.advance(SAVE_ANSWER_TIMEOUT_MS);
    h.page.save();
    await h.pump();
    await h.answer(1, { kind: "not_sent" });
    assert.equal(h.view.message, "The request was not sent to Stream Deck.");
    await h.answer(0, { kind: "sent" });
    assert.equal(
      h.view.message,
      "The request was not sent to Stream Deck.",
      "the newer outcome stays",
    );
    const before = h.view.snapshot();
    h.page.receive({
      type: "connection_status",
      context: "ctx",
      pageNonce: "page-nonce-999999",
      challenge: "challenge-99999999",
      seq: 99,
      requestId: null,
      status: connectionStatusView({ ...FACTS, link: "connected" }),
    });
    assert.deepEqual(h.view.snapshot(), before);
  });

  it("a closed socket or a failed send is visible; nothing is sent or taken afterwards", async () => {
    const h = pair();
    await h.bound();
    h.close();
    h.page.inputChanged(B);
    h.page.save();
    assert.equal(h.view.message, "Not connected to Stream Deck; the request was not sent.");
    h.page.transportClosed();
    assert.equal(h.view.status, "Disconnected from Stream Deck. Close and reopen this inspector.");
    assert.deepEqual([h.view.saveEnabled, h.view.recovery], [false, "none"]);
    h.page.save();
    h.page.retry();
    assert.equal(h.toPlugin.length, 0);
  });
});

describe("ConnectionPage texts", () => {
  it("names the legacy file as the configuration file of an earlier test build", () => {
    const blocked = (reason: StatusBlockReason) =>
      statusText(connectionStatusView({ ...FACTS, view: { kind: "blocked", reason } }));
    const reasons: readonly StatusBlockReason[] = [
      "legacy_unreadable",
      "legacy_malformed",
      "legacy_invalid_address",
      "legacy_invalid_target_only",
    ];
    assert.deepEqual(reasons.map(blocked), [
      "The configuration file of an earlier test build could not be read.",
      "The configuration file of an earlier test build is not valid.",
      "The address in the configuration file of an earlier test build is not valid.",
      "The configuration file of an earlier test build has neither a valid address nor a valid agent.",
    ]);
  });

  it("connected only from the link; switch_blocked and read failures say exactly what is known", () => {
    const status = (facts: Partial<ConnectionFacts>) =>
      statusText(connectionStatusView({ ...FACTS, ...facts }));
    assert.equal(status({ link: "connected" }), `Connected to Paseo at ${A}.`);
    assert.equal(status({ link: "reconnecting" }), `Offline. Reconnecting to ${A}…`);
    assert.equal(status({ link: "auth_failed" }), "Password protected daemon is not supported.");
    assert.equal(
      status({ view: { kind: "blocked", reason: "settings_unavailable" } }),
      "Plugin settings could not be read. Close and reopen this inspector to read them again.",
    );
    const unknownRead = detailLines(
      connectionStatusView({
        ...FACTS,
        view: { kind: "blocked", reason: "settings_unavailable" },
        saved: { kind: "unavailable" },
        settingsRead: "timed_out",
      }),
    );
    assert.equal(
      unknownRead.some((line) => line.includes("last known")),
      false,
    );
    const knownRead = detailLines(connectionStatusView({ ...FACTS, settingsRead: "failed" }));
    assert.ok(knownRead.some((line) => line.includes("last known")));
    assert.deepEqual(
      detailLines(connectionStatusView({ ...FACTS, settingsRead: "pending", sending: B })),
      [`Sending to Stream Deck: ${B}…`, "Reading plugin settings…"],
    );
  });

  it("every Save outcome has its own text; none claims a permanent save or a connection", () => {
    const kinds = [
      "invalid",
      "not_loaded",
      "malformed",
      "not_json",
      "unchanged",
      "saved_not_active",
      "sent",
      "sent_superseded",
      "not_sent",
      "replaced",
      "stopped",
    ] as const;
    const texts = kinds.map((kind) => outcomeText(kind, kind === "invalid" ? "empty" : null));
    assert.equal(new Set(texts).size, kinds.length, "each its own text");
    for (const text of texts) {
      assert.ok(text.length > 0);
      assert.doesNotMatch(text, /permanent|stored|connected/i);
    }
    assert.match(outcomeText("saved_not_active", null), /not in use/);
  });

  it("the status line alone tells a read failure that blocks; no repeated detail line", () => {
    const lines = detailLines(
      connectionStatusView({
        ...FACTS,
        view: { kind: "blocked", reason: "settings_unavailable" },
        saved: { kind: "unavailable" },
        settingsRead: "failed",
      }),
    );
    assert.deepEqual(lines, []);
  });
});

describe("ConnectionPage: an answer during the hand-over", () => {
  it("a Save answered while it is being sent ends with its outcome, not Sending", () => {
    const view = new RecordingView();
    const clock = new ManualScheduler();
    let page: ConnectionPage | null = null;
    const nonce = "page-nonce-000001";
    const challenge = "challenge-00000001";
    page = new ConnectionPage({
      context: "ctx",
      view,
      transport: {
        send: (message) => {
          if (message.type === "connection_save") {
            // The answer arrives before send returns.
            page?.receive({
              type: "connection_save_result",
              context: "ctx",
              pageNonce: nonce,
              challenge,
              seq: 2,
              requestId: message.requestId,
              outcome: "invalid",
              error: "invalid_format",
              status: connectionStatusView(FACTS),
            });
          }
          return true;
        },
      },
      newNonce: () => nonce,
      after: (delayMs, callback) => clock.after(delayMs, callback),
    });
    page.start();
    page.receive({ type: "connection_challenge", context: "ctx", pageNonce: nonce, challenge });
    page.receive({
      type: "connection_bound",
      context: "ctx",
      pageNonce: nonce,
      challenge,
      seq: 1,
      status: connectionStatusView(FACTS),
    });
    page.inputChanged("ws://example.com:1/ws");
    page.save();
    assert.equal(view.message, outcomeText("invalid", "invalid_format"));
    assert.equal(view.saveEnabled, true);
    assert.equal(clock.pendingTimers, 0, "no answer timer left");
  });

  it("a Save whose send fails is rolled back: no waiting, Save enabled again", () => {
    const view = new RecordingView();
    const clock = new ManualScheduler();
    let open = true;
    const nonce = "page-nonce-000001";
    const challenge = "challenge-00000001";
    const page = new ConnectionPage({
      context: "ctx",
      view,
      transport: { send: () => open },
      newNonce: () => nonce,
      after: (delayMs, callback) => clock.after(delayMs, callback),
    });
    page.start();
    page.receive({ type: "connection_challenge", context: "ctx", pageNonce: nonce, challenge });
    page.receive({
      type: "connection_bound",
      context: "ctx",
      pageNonce: nonce,
      challenge,
      seq: 1,
      status: connectionStatusView(FACTS),
    });
    open = false;
    page.save();
    assert.equal(view.message, "Not connected to Stream Deck; the request was not sent.");
    assert.deepEqual([view.saveEnabled, clock.pendingTimers], [true, 0]);
  });
});

describe("ConnectionPage: tracking a Save ends with the session or socket", () => {
  it("reset, Reconnect, then the old Save's late answer: unknown, never Sending or a success", async () => {
    const h = pair();
    await h.bound();
    h.page.inputChanged(B);
    h.page.save();
    await h.pump();
    assert.equal(h.view.message, "Sending…");
    // A new appearance resets the binding while the Save waits.
    await h.plugin.shown("ctx");
    await h.pump();
    assert.match(h.view.message, /reset before this Save's answer; its outcome is unknown/);
    assert.equal(h.clock.pendingTimers, 0, "no answer timer left");
    h.page.reconnect();
    await h.pump();
    assert.equal(h.view.saveEnabled, true);
    assert.match(h.view.message, /outcome is unknown/, "the new binding claims nothing");
    // The old session's Save answers late; it belongs to the old binding.
    await h.answer(0, { kind: "sent" });
    assert.match(h.view.message, /outcome is unknown/);
    assert.equal(h.view.inputWrites, 1, "the draft stays");
    assert.equal(h.savesSent().length, 1, "never repeated");
    assert.equal(h.clock.pendingTimers, 0);
  });

  it("a close with a Save waiting: unknown, no stale details, no timer", async () => {
    const h = pair();
    h.setFacts({ ...FACTS, settingsRead: "pending", sending: B });
    await h.bound();
    assert.notEqual(h.view.details.length, 0);
    h.page.inputChanged(B);
    h.page.save();
    await h.pump();
    h.page.transportClosed();
    assert.match(h.view.message, /Disconnected before this Save's answer; its outcome is unknown/);
    assert.deepEqual(h.view.details, []);
    assert.equal(h.view.status, "Disconnected from Stream Deck. Close and reopen this inspector.");
    assert.equal(h.clock.pendingTimers, 0);
  });

  it("a reset or close without a waiting Save invents no unknown outcome", async () => {
    const h = pair();
    await h.bound();
    await h.plugin.shown("ctx");
    await h.pump();
    assert.equal(h.view.message, "");
    h.page.transportClosed();
    assert.equal(h.view.message, "");
  });
});
