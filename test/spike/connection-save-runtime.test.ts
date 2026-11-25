import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { LegacyFileRead } from "../../src/connection/connection-model.ts";
import type { JsonObject } from "../../src/connection/connection-save.ts";
import type { PluginMessage } from "../../src/inspector/connection-protocol.ts";
import { connectionStatusView } from "../../src/spike/connection-inspector.ts";
import { createPluginRuntime } from "../../src/spike/plugin-runtime.ts";
import { deferred, FakeClient, ManualScheduler } from "../support/fake-client.ts";

/**
 * Save through the real runtime factory (C4a2): the one feed lifecycle with
 * its one GlobalSettingsReader and ConnectionSaver, real FeedRecovery and
 * AgentFeed over FakeClient, a fake SDK for the global settings (reads,
 * outside changes and writes the test settles) and a manual clock. No key
 * or dial is shown, no real SDK, settings, file or daemon. The runtime's
 * connection port is called directly: no SDK event reaches it yet.
 */

const A = "ws://localhost:7901/ws";
const B = "ws://localhost:7902/ws";
const C = "ws://localhost:7903/ws";
const saved = (daemonUrl: string) => ({ connection: { version: 1, daemonUrl } });

/** One setGlobalSettings call the test settles. */
interface Write {
  readonly settings: JsonObject;
  readonly accept: () => Promise<void>;
  readonly refuse: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup(options: { settings: unknown; legacy?: LegacyFileRead }) {
  const clock = new ManualScheduler();
  const lines: string[] = [];
  const clients: { url: string; client: FakeClient }[] = [];
  const writes: Write[] = [];
  const messages: { context: string; message: PluginMessage }[] = [];
  let challenges = 0;
  /** Effects in order: client creation and close, by address. */
  const order: string[] = [];
  let listener: ((settings: unknown) => void) | null = null;
  let throwOnWrite = false;
  let configure: (client: FakeClient, url: string) => void = () => undefined;
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
    readLegacyFile: () => Promise.resolve(options.legacy ?? { kind: "missing" }),
    getGlobalSettings: () => Promise.resolve(options.settings),
    subscribeGlobalSettings: (next) => {
      listener = next;
      return {
        dispose: () => {
          listener = null;
        },
      };
    },
    setGlobalSettings: (settings) => {
      if (throwOnWrite) throw new Error("sync");
      const sent = deferred<"ok" | "refused">();
      const outcome = sent.promise.then((result) => {
        if (result === "refused") throw new Error("refused");
      });
      writes.push({
        settings,
        accept: async () => {
          sent.resolve("ok");
          await outcome.catch(() => undefined);
        },
        refuse: async () => {
          sent.resolve("refused");
          await outcome.catch(() => undefined);
        },
      });
      check();
      return outcome;
    },
    createClient: (url) => {
      const client = new (class extends FakeClient {
        override close(): Promise<void> {
          order.push(`close ${url}`);
          return super.close();
        }
      })();
      configure(client, url);
      clients.push({ url, client });
      order.push(`create ${url}`);
      check();
      return client;
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
    sendToInspector: () => Promise.resolve(),
    open: () => Promise.resolve("requested"),
    now: () => 0,
    exit: () => {
      lines.push("exit");
    },
    log: { info: record, warn: record, error: record },
  });
  const h = {
    runtime,
    clock,
    lines,
    clients,
    writes,
    order,
    messages,
    urls: () => clients.map((entry) => entry.url),
    started: () => lines.filter((line) => line === "feed started").length,
    status: () => runtime.connection.status(),
    /** Settles once `ready` holds; checked after every log line, client and write. */
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
    throwOnWrite: () => {
      throwOnWrite = true;
    },
    configure: (next: (client: FakeClient, url: string) => void) => {
      configure = next;
    },
    /** Starts the runtime and waits until its first feed has started. */
    running: async () => {
      await runtime.start();
      await h.until(() => h.started() === 1);
    },
  };
  cleanups.push(async () => {
    await runtime.shutdown();
    for (const write of writes) await write.accept();
    assert.equal(clock.pendingTimers, 0, "no timer left");
    assert.equal(clock.active, 0, "no link poll left");
  });
  return h;
}

/** Holds the client's close until the returned function is called. */
function holdClose(client: FakeClient): () => void {
  const gate = deferred<undefined>();
  client.closeGate = gate.promise.then(() => undefined);
  return () => {
    gate.resolve(undefined);
  };
}

describe("runtime connection Save (C4a2)", () => {
  it("a new address: sent, then the old client is closed before the new one is created", async () => {
    const h = setup({ settings: saved(A) });
    await h.running();
    const saving = h.runtime.connection.save(B);
    assert.deepEqual(h.status().sending, B, "the requested address is being sent");
    assert.equal(h.status().view.kind, "active", "sending starts nothing");
    assert.deepEqual(h.urls(), [A]);
    await h.writes[0]?.accept();
    assert.deepEqual(await saving, { kind: "sent" });
    await h.until(() => h.started() === 2);
    assert.deepEqual(h.order, [`create ${A}`, `close ${A}`, `create ${B}`]);
    assert.deepEqual(h.writes[0]?.settings, saved(B));
    const status = h.status();
    assert.deepEqual(status.view, { kind: "active", daemonUrl: B, source: "saved" });
    assert.deepEqual([status.sent, status.sending], [B, null]);
  });

  it("a refused or throwing send keeps the connection and changes nothing known", async () => {
    const refused = setup({ settings: saved(A) });
    await refused.running();
    const saving = refused.runtime.connection.save(B);
    await refused.writes[0]?.refuse();
    assert.deepEqual(await saving, { kind: "not_sent" });
    assert.deepEqual(refused.urls(), [A]);
    assert.equal(refused.clients[0]?.client.closed, 0);
    assert.deepEqual(refused.status().saved, { kind: "ok", daemonUrl: A });
    assert.deepEqual([refused.status().sent, refused.status().sending], [null, null]);

    const thrown = setup({ settings: saved(A) });
    await thrown.running();
    thrown.throwOnWrite();
    assert.deepEqual(await thrown.runtime.connection.save(B), { kind: "not_sent" });
    assert.deepEqual(thrown.urls(), [A]);
    assert.equal(thrown.clients[0]?.client.closed, 0);
  });

  it("the saved and active address is not written", async () => {
    const h = setup({ settings: { ...saved(A), other: 1 } });
    await h.running();
    assert.deepEqual(await h.runtime.connection.save(A), { kind: "unchanged" });
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.urls(), [A]);
  });

  it("an active legacy or default address is written; it becomes saved without a restart", async () => {
    const cases: [LegacyFileRead, string, string][] = [
      [{ kind: "text", text: JSON.stringify({ daemonUrl: A }) }, A, "legacy"],
      [{ kind: "missing" }, "ws://127.0.0.1:6767/ws", "default"],
    ];
    for (const [legacy, url, source] of cases) {
      const h = setup({ settings: { keep: true }, legacy });
      await h.running();
      assert.deepEqual(h.status().view, { kind: "active", daemonUrl: url, source });
      const saving = h.runtime.connection.save(url);
      await h.writes[0]?.accept();
      assert.deepEqual(await saving, { kind: "sent" });
      assert.deepEqual(h.writes[0]?.settings, { keep: true, ...saved(url) });
      assert.deepEqual(h.status().view, { kind: "active", daemonUrl: url, source: "saved" });
      assert.deepEqual(h.urls(), [url], "no new client");
      assert.equal(h.clients[0]?.client.closed, 0, "no restart");
    }
  });

  it("an unconfirmed close: the address is sent but not active; Save of it again writes nothing", async () => {
    const h = setup({ settings: saved(A) });
    await h.running();
    const old = h.clients[0]?.client;
    assert.ok(old);
    old.closeError = new Error("raw close");
    const saving = h.runtime.connection.save(B);
    await h.writes[0]?.accept();
    assert.deepEqual(await saving, { kind: "sent" });
    await h.until(() => h.lines.includes("connection switch blocked: failed"));
    const status = h.status();
    assert.deepEqual(status.view, { kind: "switch_blocked" });
    assert.deepEqual(status.saved, { kind: "ok", daemonUrl: B });
    assert.equal(status.sent, B);
    assert.equal(status.link, "none", "no feed, so no link and never connected");
    assert.deepEqual(await h.runtime.connection.save(B), { kind: "saved_not_active" });
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.urls(), [A], "Save never bypasses switch_blocked");
  });

  it("a Save while the old client closes follows the newest request: only the last address starts", async () => {
    const h = setup({ settings: saved(A) });
    await h.running();
    const old = h.clients[0]?.client;
    assert.ok(old);
    const release = holdClose(old);
    const first = h.runtime.connection.save(B);
    await h.writes[0]?.accept();
    assert.deepEqual(await first, { kind: "sent" });
    assert.equal(h.status().view.kind, "switching");
    const second = h.runtime.connection.save(C);
    await h.until(() => h.writes.length === 2);
    await h.writes[1]?.accept();
    assert.deepEqual(await second, { kind: "sent" });
    release();
    await h.until(() => h.started() === 2);
    assert.deepEqual(h.urls(), [A, C], "B never started");
    assert.equal(old.closed, 1);
  });

  it("a newer outside change while the SDK send waits is applied; the late success does not overwrite it", async () => {
    const h = setup({ settings: saved(A) });
    await h.running();
    const saving = h.runtime.connection.save(B);
    h.emitOutside(saved(C));
    await h.until(() => h.started() === 2);
    assert.deepEqual(h.urls(), [A, C]);
    await h.writes[0]?.accept();
    assert.deepEqual(await saving, { kind: "sent_superseded" });
    assert.deepEqual(h.status().saved, { kind: "ok", daemonUrl: C });
    assert.equal(h.status().sent, null);
    assert.deepEqual(h.urls(), [A, C], "B never started");
  });

  it("shutdown with a pending Save: stopped; the late SDK success starts nothing", async () => {
    const h = setup({ settings: saved(A) });
    await h.running();
    const saving = h.runtime.connection.save(B);
    await h.runtime.shutdown();
    assert.deepEqual(await saving, { kind: "stopped" });
    await h.writes[0]?.accept();
    assert.deepEqual(h.urls(), [A]);
    assert.deepEqual(h.status().saved, { kind: "ok", daemonUrl: A }, "known stays as it was");
    assert.deepEqual(await h.runtime.connection.save(C), { kind: "stopped" });
    assert.equal(h.writes.length, 1);
  });

  it("an active owner that is not connected yet is active, never connected", async () => {
    const connect = deferred<undefined>();
    const h = setup({ settings: saved(A) });
    h.configure((client) => {
      client.connectGate = connect.promise.then(() => undefined);
    });
    await h.runtime.start();
    await h.until(() => h.clients.length === 1);
    const before = h.status();
    assert.deepEqual(before.view, { kind: "active", daemonUrl: A, source: "saved" });
    assert.notEqual(before.link, "connected");
    connect.resolve(undefined);
    await h.until(() => h.started() === 1);
    assert.equal(h.status().link, "connected");
  });

  it("status is a fresh read-only snapshot, not a live object", async () => {
    const h = setup({ settings: saved(A) });
    await h.running();
    const first = h.status();
    assert.notEqual(h.status(), first);
    assert.equal(Object.hasOwn(h.runtime.connection, "reader"), false);
    assert.equal(Object.hasOwn(h.runtime.connection, "saver"), false);
  });

  describe("through an action's inspector (protocol v2)", () => {
    /** Opens the context's inspector and binds a page nonce to it, as a page would. */
    const bind = async (h: ReturnType<typeof setup>, context: string, pageNonce: string) => {
      await h.runtime.connection.inspectorShown(context);
      await h.runtime.connection.inspectorMessage(context, { type: "connection_hello", pageNonce });
      const offer = h.messages.at(-1)?.message;
      assert.ok(offer?.type === "connection_challenge" && offer.pageNonce === pageNonce);
      const mark = h.messages.length;
      await h.runtime.connection.inspectorMessage(context, {
        type: "connection_confirm",
        pageNonce,
        challenge: offer.challenge,
      });
      // C4a4b: the bind starts one settings read, whose status follows the bound.
      assert.equal(h.messages[mark]?.message.type, "connection_bound");
      return { pageNonce, challenge: offer.challenge };
    };

    /** The status a bound page saw last: its own binding, highest seq. */
    const lastStatusOf = (h: ReturnType<typeof setup>, context: string) => {
      let best: { seq: number; status: ReturnType<typeof connectionStatusView> } | null = null;
      for (const { context: to, message } of h.messages) {
        if (to !== context || !("seq" in message)) continue;
        if (best === null || message.seq > best.seq)
          best = { seq: message.seq, status: message.status };
      }
      assert.ok(best !== null);
      return best.status;
    };

    it("a bound page's Save writes once, answers with its outcome, and the switch is pushed", async () => {
      const h = setup({ settings: saved(A) });
      await h.running();
      const page = await bind(h, "ctx", "page-nonce-000001");
      const answering = h.runtime.connection.inspectorMessage("ctx", {
        type: "connection_save",
        ...page,
        requestId: "r1",
        daemonUrl: B,
      });
      await h.until(() => h.writes.length === 1);
      await h.writes[0]?.accept();
      await answering;
      const result = h.messages.find((entry) => entry.message.type === "connection_save_result");
      assert.ok(result?.message.type === "connection_save_result");
      assert.deepEqual(
        [result.message.requestId, result.message.outcome, result.message.pageNonce],
        ["r1", "sent", page.pageNonce],
      );
      await h.until(() => h.started() === 2);
      await h.until(() => {
        const status = lastStatusOf(h, "ctx");
        return status.active?.daemonUrl === B && status.link === "connected";
      });
      assert.equal(h.writes.length, 1, "one write");
    });

    it("an unbound or stale page never writes; shutdown drops a pending Save's answer and starts nothing", async () => {
      const h = setup({ settings: saved(A) });
      await h.running();
      await h.runtime.connection.inspectorShown("ctx");
      await h.runtime.connection.inspectorMessage("ctx", {
        type: "connection_save",
        pageNonce: "page-nonce-000009",
        challenge: "challenge-99999999",
        requestId: "r0",
        daemonUrl: B,
      });
      assert.equal(h.writes.length, 0, "no binding, no write");
      const page = await bind(h, "ctx", "page-nonce-000001");
      await h.runtime.connection.inspectorMessage("ctx", {
        type: "connection_get_status",
        ...page,
        requestId: "s1",
      });
      assert.equal(h.writes.length, 0, "status never writes");
      const answering = h.runtime.connection.inspectorMessage("ctx", {
        type: "connection_save",
        ...page,
        requestId: "r1",
        daemonUrl: B,
      });
      await h.until(() => h.writes.length === 1);
      const before = h.messages.length;
      await h.runtime.shutdown();
      await h.writes[0]?.accept();
      await answering;
      assert.equal(h.messages.length, before, "nothing sent after shutdown");
      assert.deepEqual(h.urls(), [A]);
    });

    it("every bound page ends on the runtime's status after a Save of the active address, by either path", async () => {
      for (const path of ["inspector", "port"] as const) {
        const h = setup({ settings: {} });
        await h.running();
        const url = "ws://127.0.0.1:6767/ws";
        const one = await bind(h, "one", "page-nonce-000001");
        await bind(h, "two", "page-nonce-000002");
        const saving =
          path === "inspector"
            ? h.runtime.connection.inspectorMessage("one", {
                type: "connection_save",
                ...one,
                requestId: "r1",
                daemonUrl: url,
              })
            : h.runtime.connection.save(url);
        await h.until(() => h.writes.length === 1);
        assert.equal(lastStatusOf(h, "two").sending, url, `${path}: start pushed`);
        await h.writes[0]?.accept();
        await saving;
        const runtime = connectionStatusView(h.status());
        assert.deepEqual([runtime.sent, runtime.sending], [url, null]);
        assert.deepEqual(lastStatusOf(h, "one"), runtime, `${path}: one`);
        assert.deepEqual(lastStatusOf(h, "two"), runtime, `${path}: two`);
        assert.deepEqual(h.urls(), [url], "no feed event was needed");
      }
    });

    it("after a refused Save and after a queued Save, every bound page matches the runtime's status", async () => {
      const h = setup({ settings: saved(A) });
      await h.running();
      await bind(h, "one", "page-nonce-000001");
      await bind(h, "two", "page-nonce-000002");
      const refused = h.runtime.connection.save(B);
      await h.until(() => h.writes.length === 1);
      await h.writes[0]?.refuse();
      assert.deepEqual(await refused, { kind: "not_sent" });
      for (const context of ["one", "two"]) {
        assert.deepEqual(lastStatusOf(h, context), connectionStatusView(h.status()), context);
      }
      const old = h.clients[0]?.client;
      assert.ok(old);
      const release = holdClose(old);
      const first = h.runtime.connection.save(B);
      const queued = h.runtime.connection.save(C);
      await h.until(() => h.writes.length === 2);
      await h.writes[1]?.accept();
      await first;
      await h.until(() => h.writes.length === 3);
      assert.equal(lastStatusOf(h, "two").sending, C, "the queued Save's start is pushed");
      await h.writes[2]?.accept();
      await queued;
      for (const context of ["one", "two"]) {
        assert.deepEqual(lastStatusOf(h, context), connectionStatusView(h.status()), context);
      }
      release();
      await h.until(() => h.started() === 2);
      assert.deepEqual(h.urls(), [A, C]);
    });
  });
});
