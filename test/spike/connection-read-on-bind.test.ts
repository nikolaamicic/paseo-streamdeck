import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SETTINGS_READ_TIMEOUT_MS } from "../../src/connection/settings-reader.ts";
import type { PluginMessage } from "../../src/inspector/connection-protocol.ts";
import { connectionStatusView } from "../../src/spike/connection-inspector.ts";
import { createPluginRuntime } from "../../src/spike/plugin-runtime.ts";
import { deferred, FakeClient, ManualScheduler } from "../support/fake-client.ts";

/**
 * Read on bind (C4a4b) through the real runtime factory: the one
 * lifecycle with its one GlobalSettingsReader, the inspector controller,
 * FeedRecovery and AgentFeed over FakeClient, a fake SDK whose reads and
 * outside changes the test settles, and a manual clock. The runtime's
 * connection port is called as the SDK classes would; no real page, SDK,
 * settings or daemon.
 */

const A = "ws://localhost:7801/ws";
const B = "ws://localhost:7802/ws";
const saved = (daemonUrl: string) => ({ connection: { version: 1, daemonUrl } });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** One getGlobalSettings call the test settles. */
interface Read {
  readonly resolve: (settings: unknown) => void;
  readonly reject: () => void;
  readonly done: Promise<unknown>;
}

function setup(initial: unknown) {
  const clock = new ManualScheduler();
  const lines: string[] = [];
  const reads: Read[] = [];
  const writes: unknown[] = [];
  const clients: { url: string; client: FakeClient }[] = [];
  const messages: { context: string; message: PluginMessage }[] = [];
  let listener: ((settings: unknown) => void) | null = null;
  let throwNextRead = false;
  let challenges = 0;
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
      if (throwNextRead) {
        throwNextRead = false;
        throw new Error("raw sync");
      }
      const answer = deferred<unknown>();
      let reject: () => void = () => undefined;
      const done = new Promise<unknown>((resolve, fail) => {
        answer.promise.then(resolve, fail);
        reject = () => {
          fail(new Error("raw refused"));
        };
      });
      reads.push({ resolve: answer.resolve, reject, done });
      check();
      return done;
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
      writes.push(settings);
      return Promise.resolve();
    },
    newChallenge: () => {
      challenges += 1;
      return `challenge-${String(challenges).padStart(8, "0")}`;
    },
    sendConnectionMessage: (context, message) => {
      messages.push({ context, message });
      check();
      return Promise.resolve();
    },
    createClient: (url) => {
      const client = new FakeClient();
      clients.push({ url, client });
      check();
      return client;
    },
    sendToInspector: () => Promise.resolve(),
    open: () => Promise.resolve("requested"),
    now: () => 0,
    exit: () => undefined,
    log: { info: record, warn: record, error: record },
  });
  const h = {
    runtime,
    clock,
    reads,
    writes,
    clients,
    messages,
    lines,
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
    throwNextRead: () => {
      throwNextRead = true;
    },
    status: () => runtime.connection.status(),
    started: () => lines.filter((line) => line === "feed started").length,
    /** Starts the runtime: the first read is answered with `initial`. */
    running: async () => {
      const run = runtime.start();
      await h.answer(0, initial);
      await run;
      await h.until(() => h.started() === 1);
    },
    answer: async (index: number, settings: unknown) => {
      await h.until(() => reads.length > index);
      const read = reads[index];
      assert.ok(read);
      read.resolve(settings);
      await read.done;
    },
    refuse: async (index: number) => {
      const read = reads[index];
      assert.ok(read);
      read.reject();
      await read.done.catch(() => undefined);
    },
    /** Opens the context's inspector and binds a page nonce, as a page would. */
    bind: async (context: string, pageNonce: string) => {
      await runtime.connection.inspectorShown(context);
      await runtime.connection.inspectorMessage(context, { type: "connection_hello", pageNonce });
      const offer = messages.at(-1)?.message;
      assert.ok(offer?.type === "connection_challenge" && offer.pageNonce === pageNonce);
      await runtime.connection.inspectorMessage(context, {
        type: "connection_confirm",
        pageNonce,
        challenge: offer.challenge,
      });
      return { pageNonce, challenge: offer.challenge };
    },
    /** The status the bound page of `context` last accepted: its binding, highest seq. */
    lastStatusOf: (context: string, pageNonce: string) => {
      let best: { seq: number; status: ReturnType<typeof connectionStatusView> } | null = null;
      for (const { context: to, message } of messages) {
        if (to !== context || !("seq" in message) || message.pageNonce !== pageNonce) continue;
        if (best === null || message.seq > best.seq)
          best = { seq: message.seq, status: message.status };
      }
      assert.ok(best !== null);
      return best.status;
    },
  };
  cleanups.push(async () => {
    await runtime.shutdown();
    for (const read of reads) {
      read.resolve({});
      await read.done.catch(() => undefined);
    }
    assert.equal(clock.pendingTimers, 0, "no timer left");
  });
  return h;
}

const matchesFacts = (h: ReturnType<typeof setup>, context: string, pageNonce: string) =>
  JSON.stringify(h.lastStatusOf(context, pageNonce)) ===
  JSON.stringify(connectionStatusView(h.status()));

describe("read on bind through the runtime (C4a4b)", () => {
  it("a bind reads once; the page sees pending, then idle, matching the facts", async () => {
    const h = setup(saved(A));
    await h.running();
    assert.equal(h.reads.length, 1, "the start read only");
    await h.runtime.connection.inspectorShown("ctx");
    assert.equal(h.reads.length, 1, "an appearance (also the Workspace dial's) does not read");
    await h.bind("ctx", "page-nonce-000001");
    assert.equal(h.reads.length, 2, "one read for the bind");
    assert.equal(h.lastStatusOf("ctx", "page-nonce-000001").settingsRead, "pending");
    await h.answer(1, { ...saved(A), other: 1 });
    await h.until(() => h.lastStatusOf("ctx", "page-nonce-000001").settingsRead === "idle");
    assert.ok(matchesFacts(h, "ctx", "page-nonce-000001"));
    assert.equal(h.writes.length, 0, "a read never writes");
  });

  it("repeated hello and confirm of the bound page read nothing again", async () => {
    const h = setup(saved(A));
    await h.running();
    const page = await h.bind("ctx", "page-nonce-000001");
    await h.runtime.connection.inspectorMessage("ctx", {
      type: "connection_hello",
      pageNonce: page.pageNonce,
    });
    await h.runtime.connection.inspectorMessage("ctx", { type: "connection_confirm", ...page });
    assert.equal(h.reads.length, 2);
    assert.equal(h.writes.length, 0);
  });

  it("a reopen while the read waits reuses it with a new deadline; no second SDK read", async () => {
    const h = setup(saved(A));
    await h.running();
    await h.bind("ctx", "page-nonce-000001");
    h.clock.advance(3_000);
    h.runtime.connection.inspectorHidden("ctx");
    const closedAt = h.messages.length;
    await h.bind("ctx", "page-nonce-000002");
    assert.equal(h.reads.length, 2, "the read in flight is reused");
    h.clock.advance(SETTINGS_READ_TIMEOUT_MS - 1);
    assert.equal(h.status().settingsRead, "pending", "the deadline was renewed at the second bind");
    h.clock.advance(1);
    await h.until(() => h.status().settingsRead === "timed_out");
    assert.ok(matchesFacts(h, "ctx", "page-nonce-000002"));
    assert.equal(
      h.messages
        .slice(closedAt)
        .some(
          (entry) =>
            "pageNonce" in entry.message && entry.message.pageNonce === "page-nonce-000001",
        ),
      false,
      "nothing more for the closed opening",
    );
  });

  it("a timeout, then a late fresh answer that applies; the known object stays meanwhile", async () => {
    const h = setup(saved(A));
    await h.running();
    await h.bind("ctx", "page-nonce-000001");
    h.clock.advance(SETTINGS_READ_TIMEOUT_MS);
    await h.until(() => h.lastStatusOf("ctx", "page-nonce-000001").settingsRead === "timed_out");
    assert.deepEqual(h.status().saved, { kind: "ok", daemonUrl: A }, "known kept");
    assert.deepEqual(h.status().view, { kind: "active", daemonUrl: A, source: "saved" });
    await h.answer(1, saved(B));
    // A fresh change of address goes through the usual switch: old client closed first.
    await h.until(() => h.started() === 2);
    assert.deepEqual(
      h.clients.map((entry) => entry.url),
      [A, B],
    );
    assert.equal(h.clients[0]?.client.closed, 1);
    await h.until(() => matchesFacts(h, "ctx", "page-nonce-000001"));
  });

  it("a refused or throwing read keeps the known object and the connection", async () => {
    const h = setup(saved(A));
    await h.running();
    await h.bind("ctx", "page-nonce-000001");
    await h.refuse(1);
    await h.until(() => h.lastStatusOf("ctx", "page-nonce-000001").settingsRead === "failed");
    assert.deepEqual(h.status().saved, { kind: "ok", daemonUrl: A });
    assert.deepEqual(
      h.clients.map((entry) => entry.url),
      [A],
    );

    h.runtime.connection.inspectorHidden("ctx");
    h.throwNextRead();
    await h.bind("ctx", "page-nonce-000002");
    assert.equal(h.status().settingsRead, "failed");
    assert.deepEqual(h.status().saved, { kind: "ok", daemonUrl: A });
    assert.ok(matchesFacts(h, "ctx", "page-nonce-000002"));
  });

  it("an answer older than a Save or an outside change is dropped", async () => {
    const outside = setup(saved(A));
    await outside.running();
    await outside.bind("ctx", "page-nonce-000001");
    outside.emitOutside({ ...saved(A), newer: true });
    await outside.answer(1, { stale: true });
    assert.equal(outside.status().settingsRead, "idle");
    assert.deepEqual(outside.status().saved, { kind: "ok", daemonUrl: A });
    assert.ok(matchesFacts(outside, "ctx", "page-nonce-000001"));

    const afterSave = setup({});
    await afterSave.running();
    await afterSave.bind("ctx", "page-nonce-000001");
    const saving = afterSave.runtime.connection.save("ws://127.0.0.1:6767/ws");
    assert.deepEqual(await saving, { kind: "sent" });
    assert.equal(afterSave.writes.length, 1, "the Save's own write");
    await afterSave.answer(1, saved(B));
    assert.equal(afterSave.writes.length, 1, "the read wrote nothing");
    assert.deepEqual(afterSave.status().saved, { kind: "ok", daemonUrl: "ws://127.0.0.1:6767/ws" });
    assert.deepEqual(
      afterSave.clients.map((entry) => entry.url),
      ["ws://127.0.0.1:6767/ws"],
    );
  });

  it("shutdown during the read: its late answer changes and sends nothing", async () => {
    const h = setup(saved(A));
    await h.running();
    await h.bind("ctx", "page-nonce-000001");
    const before = h.messages.length;
    await h.runtime.shutdown();
    await h.answer(1, saved(B));
    assert.equal(h.messages.length, before);
    assert.deepEqual(
      h.clients.map((entry) => entry.url),
      [A],
    );
    assert.equal(h.writes.length, 0);
  });
});
