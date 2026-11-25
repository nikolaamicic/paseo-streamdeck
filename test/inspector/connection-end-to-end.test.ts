import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { JsonObject } from "../../src/connection/connection-save.ts";
import type { PageMessage, PluginMessage } from "../../src/inspector/connection-protocol.ts";
import { ConnectionPage, type PageView } from "../../src/inspector/page/connection-page.ts";
import { createPluginRuntime } from "../../src/spike/plugin-runtime.ts";
import { deferred, FakeClient, ManualScheduler } from "../support/fake-client.ts";

/**
 * The whole connection flow end to end (C5): the real inspector page
 * (ConnectionPage over the shared protocol reducer) speaks the protocol to
 * the real runtime factory (createPluginRuntime: the one lifecycle with its
 * settings reader and Save owner, FeedRecovery and AgentFeed over
 * FakeClient), with a fake SDK for the global settings (reads, outside
 * changes and writes the test settles) and one manual clock. The wire
 * between them is in memory: no Stream Deck transport, webview, real SDK
 * or daemon. Edge cases of each layer are proved by their own tests.
 */

const A = "ws://localhost:7901/ws";
const B = "ws://localhost:7902/ws";
const C = "ws://localhost:7903/ws";
const CONTEXT = "ctx-pages";
const saved = (daemonUrl: string) => ({ connection: { version: 1, daemonUrl } });

/** The page as the user sees it. */
class View implements PageView {
  status = "";
  details: readonly string[] = [];
  message = "";
  input = "";
  saveEnabled = false;
  setStatus(text: string): void {
    this.status = text;
  }
  setDetails(lines: readonly string[]): void {
    this.details = lines;
  }
  setMessage(text: string): void {
    this.message = text;
  }
  setRecovery(): void {
    // Not asserted here; the page and DOM tests cover the recovery controls.
  }
  /** How often the page itself wrote the field (typed text lives in the DOM). */
  inputWrites = 0;
  setInput(value: string): void {
    this.input = value;
    this.inputWrites += 1;
  }
  setSaveEnabled(enabled: boolean): void {
    this.saveEnabled = enabled;
  }
}

interface Read {
  readonly resolve: (settings: unknown) => void;
  readonly done: Promise<unknown>;
}

interface Write {
  readonly settings: JsonObject;
  readonly accept: () => Promise<void>;
  readonly refuse: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function system(initial: unknown) {
  const clock = new ManualScheduler();
  const lines: string[] = [];
  const reads: Read[] = [];
  const writes: Write[] = [];
  const order: string[] = [];
  const clients: { url: string; client: FakeClient }[] = [];
  const toPage: PluginMessage[] = [];
  const toPlugin: PageMessage[] = [];
  /** Save requests the runtime is answering; awaited after the test settles the write. */
  const inflight: Promise<void>[] = [];
  let listener: ((settings: unknown) => void) | null = null;
  let challenges = 0;
  let nonces = 0;
  const waiters: { ready: () => boolean; resolve: () => void }[] = [];
  const check = () => {
    for (const waiter of waiters.splice(0)) {
      if (waiter.ready()) waiter.resolve();
      else waiters.push(waiter);
    }
  };
  const record = (line: string) => {
    lines.push(line);
    check();
  };

  const runtime = createPluginRuntime({
    timers: clock,
    feedScheduler: clock,
    readLegacyFile: () => Promise.resolve({ kind: "missing" }),
    getGlobalSettings: () => {
      const answer = deferred<unknown>();
      reads.push({ resolve: answer.resolve, done: answer.promise });
      check();
      return answer.promise;
    },
    subscribeGlobalSettings: (next) => {
      listener = next;
      return {
        dispose: () => {
          listener = null;
        },
      };
    },
    setGlobalSettings: (settings) => {
      const sent = deferred<boolean>();
      const outcome = sent.promise.then((ok) => {
        if (!ok) throw new Error("refused");
      });
      writes.push({
        settings,
        accept: async () => {
          sent.resolve(true);
          await outcome.catch(() => undefined);
        },
        refuse: async () => {
          sent.resolve(false);
          await outcome.catch(() => undefined);
        },
      });
      check();
      return outcome;
    },
    newChallenge: () => {
      challenges += 1;
      return `challenge-${String(challenges).padStart(8, "0")}`;
    },
    sendConnectionMessage: (context, message) => {
      if (context === CONTEXT) toPage.push(message);
      check();
      return Promise.resolve();
    },
    createClient: (url) => {
      const client = new (class extends FakeClient {
        override close(): Promise<void> {
          // Recorded when close is called; disposal is the client's state.
          order.push(`close ${url}`);
          check();
          return super.close();
        }
      })();
      clients.push({ url, client });
      order.push(`create ${url}`);
      check();
      return client;
    },
    sendToInspector: () => Promise.resolve(),
    open: () => Promise.resolve("requested"),
    now: () => 0,
    exit: () => undefined,
    log: { info: record, warn: record, error: record },
  });

  const view = new View();
  let socketOpen = true;
  const page = new ConnectionPage({
    context: CONTEXT,
    view,
    transport: {
      send: (message) => {
        if (!socketOpen) return false;
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
    runtime,
    clock,
    view,
    page,
    reads,
    writes,
    order,
    lines,
    clients,
    urls: () => clients.map((entry) => entry.url),
    started: () => lines.filter((line) => line === "feed started").length,
    status: () => runtime.connection.status(),
    until: (ready: () => boolean): Promise<void> => {
      if (ready()) return Promise.resolve();
      const seen = deferred<undefined>();
      waiters.push({
        ready,
        resolve: () => {
          seen.resolve(undefined);
        },
      });
      return seen.promise.then(() => undefined);
    },
    emitOutside: (settings: unknown) => {
      listener?.(settings);
    },
    closeSocket: () => {
      socketOpen = false;
    },
    /** Answers settings read `index` and waits until the reader took it. */
    answer: async (index: number, settings: unknown) => {
      await h.until(() => reads.length > index);
      const read = reads[index];
      assert.ok(read);
      read.resolve(settings);
      await read.done;
    },
    /**
     * Delivers both directions until quiet. A Save is not awaited: its
     * answer waits for the test's write decision (settle, then pump).
     */
    pump: async () => {
      for (;;) {
        const up = toPlugin.shift();
        if (up !== undefined) {
          const handled = runtime.connection.inspectorMessage(CONTEXT, up);
          if (up.type === "connection_save") inflight.push(handled);
          else await handled;
          continue;
        }
        const down = toPage.shift();
        if (down === undefined) return;
        page.receive(down);
      }
    },
    /** Settles every Save answer already handed to the runtime, then delivers. */
    settleSaves: async () => {
      await Promise.all(inflight.splice(0));
      await h.pump();
    },
    /** Starts the runtime on `initial` settings and waits for the first feed. */
    running: async () => {
      const run = runtime.start();
      await h.answer(0, initial);
      await run;
      await h.until(() => h.started() === 1);
    },
    /** Opens the inspector (SDK appearance), then the page loads and binds. */
    openPage: async () => {
      await runtime.connection.inspectorShown(CONTEXT);
      toPage.length = 0; // its ready went out before the page listened
      page.start();
      await h.pump();
    },
  };
  cleanups.push(async () => {
    await runtime.shutdown();
    for (const write of writes) await write.accept();
    for (const read of reads) {
      read.resolve({});
      await read.done;
    }
    await Promise.all(inflight.splice(0));
    clock.advance(10_000);
    assert.equal(clock.pendingTimers, 0, "no timer left");
  });
  return h;
}

describe("the connection flow end to end: page, protocol and runtime (C5)", () => {
  it("bind starts one read; the page shows the read, then the accepted status", async () => {
    const h = system({ ...saved(A), keep: { a: 1 } });
    await h.running();
    await h.openPage();
    assert.equal(h.reads.length, 2, "the bind read once");
    assert.ok(h.view.details.includes("Reading plugin settings…"));
    assert.equal(h.view.input, A, "the field shows the saved address");
    await h.answer(1, { ...saved(A), keep: { a: 1 } });
    await h.pump();
    assert.equal(h.view.status, `Connected to Paseo at ${A}.`);
    assert.deepEqual(h.view.details, []);
    assert.equal(h.view.saveEnabled, true);
    assert.equal(h.writes.length, 0, "opening never writes");
  });

  it("an explicit Save of a new address: the whole object, no new client until the old close finished, the correlated result shown", async () => {
    const h = system({ ...saved(A), keep: { a: 1 } });
    await h.running();
    await h.openPage();
    await h.answer(1, { ...saved(A), keep: { a: 1 } });
    await h.pump();
    const old = h.clients[0]?.client;
    assert.ok(old);
    // Hold A's close; release it in cleanup too, so a failure cannot hang.
    const gate = deferred<undefined>();
    old.closeGate = gate.promise.then(() => undefined);
    cleanups.unshift(() => {
      gate.resolve(undefined);
      return Promise.resolve();
    });

    h.page.inputChanged(B);
    h.page.save();
    await h.pump();
    assert.equal(h.view.message, "Sending…");
    assert.ok(h.view.details.includes(`Sending to Stream Deck: ${B}…`));
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.writes[0]?.settings, { ...saved(B), keep: { a: 1 } }, "unknown keys kept");
    await h.writes[0].accept();
    await h.settleSaves();
    assert.equal(h.view.message, "Sent to Stream Deck.");

    // A's close was called and is still pending: no B client, switching shown.
    await h.until(() => h.order.includes(`close ${A}`));
    await h.pump();
    assert.deepEqual(h.urls(), [A], "no new client while the old close is pending");
    assert.notEqual(old.getConnectionState().status, "disposed");
    assert.equal(h.status().view.kind, "switching");
    assert.equal(h.view.status, "Switching the Paseo connection…");

    gate.resolve(undefined);
    await h.until(() => h.started() === 2);
    assert.equal(old.getConnectionState().status, "disposed", "A finished closing first");
    assert.deepEqual(h.order, [`create ${A}`, `close ${A}`, `create ${B}`]);
    // The new feed's link connects; the runtime pushes the changed status.
    await h.until(() => {
      const status = h.status();
      return (
        status.view.kind === "active" && status.view.daemonUrl === B && status.link === "connected"
      );
    });
    await h.pump();
    assert.equal(h.view.status, `Connected to Paseo at ${B}.`);
    assert.equal(h.view.input, B);
  });

  it("an invalid address or a refused send changes neither the active connection nor the page's address", async () => {
    const h = system(saved(A));
    await h.running();
    await h.openPage();
    await h.answer(1, saved(A));
    await h.pump();
    h.page.inputChanged("ws://example.com:7000/ws");
    h.page.save();
    await h.pump();
    await h.settleSaves();
    assert.equal(h.view.message, "Use a local address such as ws://127.0.0.1:6767/ws.");
    assert.equal(h.writes.length, 0, "nothing written");
    h.page.inputChanged(B);
    h.page.save();
    await h.pump();
    await h.writes[0]?.refuse();
    await h.settleSaves();
    assert.equal(h.view.message, "The request was not sent to Stream Deck.");
    assert.deepEqual(h.urls(), [A]);
    assert.deepEqual(h.status().view, { kind: "active", daemonUrl: A, source: "saved" });
    assert.equal(h.view.inputWrites, 1, "the page never overwrote the typed text");
  });

  it("a newer outside change while a Save waits: the page reports it, never a success of the older address", async () => {
    const h = system(saved(A));
    await h.running();
    await h.openPage();
    await h.answer(1, saved(A));
    await h.pump();
    h.page.inputChanged(B);
    h.page.save();
    await h.pump();
    h.emitOutside(saved(C));
    await h.until(() => h.started() === 2);
    await h.writes[0]?.accept();
    await h.settleSaves();
    assert.equal(h.view.message, "Sent, but a newer setting arrived meanwhile; it is shown above.");
    assert.deepEqual(h.urls(), [A, C], "B never started");
    assert.equal(h.view.input, C, "the field shows what is saved now");
  });

  it("a reset while a Save waits: unknown on the old binding, and its late answer is no success after Reconnect", async () => {
    const h = system(saved(A));
    await h.running();
    await h.openPage();
    await h.answer(1, saved(A));
    await h.pump();
    h.page.inputChanged(B);
    h.page.save();
    await h.pump();
    // A second appearance of the same inspector: a new generation.
    await h.runtime.connection.inspectorShown(CONTEXT);
    await h.pump();
    assert.match(h.view.message, /outcome is unknown/);
    h.page.reconnect();
    await h.pump();
    await h.writes[0]?.accept();
    await h.settleSaves();
    assert.match(h.view.message, /outcome is unknown/, "the old answer is not taken");
    assert.equal(h.view.saveEnabled, true);
  });

  it("shutdown while a Save waits: the page gets nothing more and ends on an unknown outcome, never a success", async () => {
    const h = system(saved(A));
    await h.running();
    await h.openPage();
    await h.answer(1, saved(A));
    await h.pump();
    h.page.inputChanged(B);
    h.page.save();
    await h.pump();
    await h.runtime.shutdown();
    await h.writes[0]?.accept();
    await h.settleSaves();
    assert.equal(h.view.message, "Sending…", "no answer came");
    h.clock.advance(5_000);
    assert.match(h.view.message, /outcome of this Save is unknown/);
    assert.deepEqual(h.urls(), [A]);
  });
});
