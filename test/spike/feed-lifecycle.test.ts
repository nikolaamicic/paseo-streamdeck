import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { LegacyFileRead } from "../../src/connection/connection-model.ts";
import { SETTINGS_READ_TIMEOUT_MS } from "../../src/connection/settings-reader.ts";
import type { SdkLogLevel } from "../../src/paseo/sdk-logger.ts";
import {
  createFeedLifecycle,
  SWITCH_CLOSE_TIMEOUT_MS,
  type FeedLifecycle,
} from "../../src/spike/feed-lifecycle.ts";
import { deferred, FakeClient, ManualScheduler } from "../support/fake-client.ts";
import { SERVER_ID } from "../support/fixtures.ts";

/**
 * The plugin's feed lifecycle (M11b1, connection sources C3a3) with the
 * real GlobalSettingsReader, FeedRecovery and AgentFeed over a fake
 * client, a fake settings SDK whose reads the test answers, a legacy file
 * read the test gives, and a manual clock for every timer. No daemon, no
 * Stream Deck, no real file.
 */

const DEFAULT = "ws://127.0.0.1:6767/ws";
const TARGET = { serverId: SERVER_ID, agentId: "agent-1" };
const legacyText = (value: unknown): LegacyFileRead => ({
  kind: "text",
  text: JSON.stringify(value),
});

/** A settings read the test settles. */
interface Read {
  readonly resolve: (settings: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly done: Promise<unknown>;
  settled: boolean;
}

/** What the cleanup after each test needs from a harness. */
interface Cleanup {
  readonly lifecycle: FeedLifecycle;
  readonly reads: Read[];
  readonly clock: ManualScheduler;
  readonly sdkCalls: string[];
}

/** Every lifecycle of a test is stopped after it; no timer or subscription is left. */
const harnesses: Cleanup[] = [];

function harness(
  legacy: LegacyFileRead | Promise<LegacyFileRead> = { kind: "missing" },
  /** Holds every client's connect until it resolves. */
  connectGate: Promise<void> | null = null,
) {
  const clock = new ManualScheduler();
  const lines: string[] = [];
  const clients: { url: string; client: FakeClient; report: (level: SdkLogLevel) => void }[] = [];
  const reads: Read[] = [];
  const sdkCalls: string[] = [];
  let listener: ((settings: unknown) => void) | null = null;
  let legacyReads = 0;
  /** Waiters of until(): checked after every render, log line and new client. */
  const waiters: { ready: () => boolean; resolve: () => void }[] = [];
  const check = () => {
    for (const waiter of waiters.splice(0)) {
      if (waiter.ready()) waiter.resolve();
      else waiters.push(waiter);
    }
  };
  /** Sets up each new client before the feed uses it; may throw to refuse it. */
  let configureClient: (client: FakeClient, url: string) => void = () => undefined;
  let renders = 0;
  let shuttingDown = false;
  const started = deferred<undefined>();
  const record = (line: string) => {
    lines.push(line);
    if (line === "feed started") started.resolve(undefined);
    check();
  };
  const lifecycle = createFeedLifecycle({
    readLegacyFile: () => {
      legacyReads += 1;
      return Promise.resolve(legacy);
    },
    getGlobalSettings: () => {
      sdkCalls.push("get");
      let resolve: (settings: unknown) => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      const done = new Promise<unknown>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      const read: Read = {
        resolve: (settings) => {
          read.settled = true;
          resolve(settings);
        },
        reject: (error) => {
          read.settled = true;
          reject(error);
        },
        done,
        settled: false,
      };
      reads.push(read);
      return done;
    },
    subscribeGlobalSettings: (next) => {
      sdkCalls.push("subscribe");
      listener = next;
      return {
        dispose: () => {
          sdkCalls.push("unsubscribe");
          listener = null;
        },
      };
    },
    // No test in this file saves; a call is recorded and refused.
    setGlobalSettings: () => {
      sdkCalls.push("set");
      return Promise.reject(new Error("no Save here"));
    },
    createClient: (url, report) => {
      const client = new FakeClient();
      client.connectGate = connectGate;
      configureClient(client, url);
      clients.push({ url, client, report });
      check();
      return client;
    },
    timers: clock,
    feedOptions: { scheduler: clock },
    onChange: () => {
      renders += 1;
      check();
    },
    shutdownStarted: () => shuttingDown,
    log: { info: record, warn: record, error: record },
  });
  const h = {
    lifecycle,
    clock,
    lines,
    clients,
    /**
     * Settles once `ready` holds, checked now and after every render, log
     * line and new client: an explicit signal instead of a flush.
     */
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
    configure: (next: (client: FakeClient, url: string) => void) => {
      configureClient = next;
    },
    reads,
    sdkCalls,
    started: started.promise,
    renders: () => renders,
    legacyReads: () => legacyReads,
    /** An outside settings change, delivered synchronously as the SDK does. */
    emitOutside: (settings: unknown) => {
      listener?.(settings);
    },
    beginShutdown: () => {
      shuttingDown = true;
    },
    /** Answers the read and waits until the lifecycle has handled it. */
    answer: async (index: number, settings: unknown) => {
      const read = reads[index];
      assert.ok(read, `settings read ${String(index)} was sent`);
      read.resolve(settings);
      await read.done;
    },
    refuse: async (index: number) => {
      const read = reads[index];
      assert.ok(read, `settings read ${String(index)} was sent`);
      read.reject(new Error("rejected"));
      await read.done.catch(() => undefined);
    },
  };
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.lifecycle.stop();
    for (const read of h.reads.filter((candidate) => !candidate.settled)) {
      read.resolve({});
      await read.done;
    }
    assert.equal(h.clock.pendingTimers, 0, "no timer left");
    assert.equal(h.clock.active, 0, "no link poll left");
    if (h.sdkCalls.includes("subscribe")) {
      assert.equal(h.sdkCalls.at(-1), "unsubscribe", "the settings subscription was disposed");
    }
  }
});

const connection = (lifecycle: FeedLifecycle) => lifecycle.source().connection;

describe("createFeedLifecycle: creating and starting", () => {
  it("creating it reads nothing, subscribes to nothing and creates no client", () => {
    const h = harness();
    assert.deepEqual([h.sdkCalls, h.legacyReads(), h.clients.length], [[], 0, 0]);
    assert.deepEqual(h.lifecycle.source(), {
      connection: { kind: "loading" },
      recovery: null,
    });
    assert.equal(h.lifecycle.retryNow(), false);
  });

  it("start subscribes, reads the settings, reads the legacy file once; loading until both decide", async () => {
    const legacy = deferred<LegacyFileRead>();
    const h = harness(legacy.promise);
    const run = h.lifecycle.start();
    assert.deepEqual(h.sdkCalls, ["subscribe", "get"]);
    assert.equal(h.legacyReads(), 1);
    await h.answer(0, {});
    assert.deepEqual(connection(h.lifecycle), { kind: "loading" }, "still waiting for the file");
    assert.equal(h.clients.length, 0);
    legacy.resolve({ kind: "missing" });
    await run;
    assert.deepEqual(connection(h.lifecycle), {
      kind: "active",
      daemonUrl: DEFAULT,
      source: "default",
    });
    assert.deepEqual(
      h.clients.map((entry) => entry.url),
      [DEFAULT],
    );
    assert.ok(h.lines.includes("legacy target: missing"));
    await h.started;
  });
});

describe("createFeedLifecycle: the three sources (plan 4.3)", () => {
  it("nothing saved and no legacy file: the default address; E1 missing", async () => {
    const h = harness({ kind: "missing" });
    const run = h.lifecycle.start();
    await h.answer(0, { unrelated: true });
    await run;
    assert.deepEqual(
      h.clients.map((entry) => entry.url),
      [DEFAULT],
    );
    assert.ok(h.lines.includes("legacy target: missing"));
    assert.ok(h.lines.includes("connection: default"));
  });

  it("nothing saved: the legacy address, even when the E1 target in it is invalid", async () => {
    const h = harness(legacyText({ daemonUrl: "ws://localhost:7000/ws", agentId: "bad/id" }));
    const run = h.lifecycle.start();
    await h.answer(0, {});
    await run;
    assert.deepEqual(
      h.clients.map((entry) => entry.url),
      ["ws://localhost:7000/ws"],
    );
    assert.deepEqual(connection(h.lifecycle), {
      kind: "active",
      daemonUrl: "ws://localhost:7000/ws",
      source: "legacy",
    });
    assert.ok(h.lines.includes("legacy target: invalid"));
  });

  it("nothing saved: a legacy file with a valid target means the default address, as before", async () => {
    const h = harness(legacyText(TARGET));
    const run = h.lifecycle.start();
    await h.answer(0, {});
    await run;
    assert.deepEqual(
      h.clients.map((entry) => entry.url),
      [DEFAULT],
    );
    assert.ok(h.lines.includes("legacy target: ok"));
    assert.equal(connection(h.lifecycle).kind, "active");
  });

  it("a saved address wins over a broken legacy file and does not wait for it", async () => {
    const legacy = deferred<LegacyFileRead>();
    const h = harness(legacy.promise);
    const run = h.lifecycle.start();
    await h.answer(0, { connection: { version: 1, daemonUrl: "ws://[::1]:7100/ws" } });
    assert.deepEqual(
      h.clients.map((entry) => entry.url),
      ["ws://[::1]:7100/ws"],
      "started before the legacy file was read",
    );
    assert.equal(
      h.lines.some((line) => line.startsWith("legacy target:")),
      false,
      "the legacy file is not read yet",
    );
    legacy.resolve({ kind: "text", text: "{ not json" });
    await run;
    assert.deepEqual(connection(h.lifecycle), {
      kind: "active",
      daemonUrl: "ws://[::1]:7100/ws",
      source: "saved",
    });
    assert.ok(h.lines.includes("legacy target: invalid"));
    assert.equal(h.clients.length, 1);
  });
});

describe("createFeedLifecycle: every source error blocks, never the default", () => {
  const cases: [string, unknown, LegacyFileRead, string][] = [
    ["malformed settings", ["not", "an", "object"], { kind: "missing" }, "settings_malformed"],
    ["an invalid saved connection", { connection: null }, { kind: "missing" }, "saved_invalid"],
    ["an unreadable legacy file", {}, { kind: "unreadable" }, "legacy_unreadable"],
    ["a malformed legacy file", {}, { kind: "text", text: "[]" }, "legacy_malformed"],
    [
      "an invalid legacy address",
      {},
      legacyText({ ...TARGET, daemonUrl: "ws://example.com:6767/ws" }),
      "legacy_invalid_address",
    ],
    ["a legacy file with only a bad target", {}, legacyText({}), "legacy_invalid_target_only"],
  ];
  for (const [name, settings, legacy, reason] of cases) {
    it(`${name}: blocked (${reason}), no client`, async () => {
      const h = harness(legacy);
      const run = h.lifecycle.start();
      await h.answer(0, settings);
      await run;
      assert.deepEqual(connection(h.lifecycle), { kind: "blocked", reason });
      assert.equal(h.clients.length, 0);
      assert.equal(h.lifecycle.retryNow(), false, "a bad source needs a fix, not a retry");
      assert.equal(h.reads.length, 1);
    });
  }
});

describe("createFeedLifecycle: unreadable settings and Retry", () => {
  it("a timed-out read blocks as settings_unavailable; a fresh late answer still starts", async () => {
    const h = harness();
    await h.lifecycle.start();
    assert.deepEqual(connection(h.lifecycle), { kind: "loading" });
    h.clock.advance(SETTINGS_READ_TIMEOUT_MS);
    assert.deepEqual(connection(h.lifecycle), {
      kind: "blocked",
      reason: "settings_unavailable",
    });
    assert.equal(h.clients.length, 0, "no silent default");
    await h.answer(0, {});
    assert.deepEqual(
      h.clients.map((entry) => entry.url),
      [DEFAULT],
    );
  });

  it("Retry while the read is still in flight sends no second read", async () => {
    const h = harness();
    await h.lifecycle.start();
    h.clock.advance(SETTINGS_READ_TIMEOUT_MS);
    assert.equal(h.lifecycle.retryNow(), true);
    assert.deepEqual(h.sdkCalls, ["subscribe", "get"]);
    assert.deepEqual(connection(h.lifecycle), { kind: "loading" }, "reading again");
    await h.answer(0, {});
    assert.equal(h.clients.length, 1);
  });

  it("a rejected read blocks; Retry reads again and starts", async () => {
    const h = harness();
    await h.lifecycle.start();
    await h.refuse(0);
    assert.deepEqual(connection(h.lifecycle), {
      kind: "blocked",
      reason: "settings_unavailable",
    });
    assert.equal(h.lifecycle.retryNow(), true);
    assert.deepEqual(h.sdkCalls, ["subscribe", "get", "get"]);
    await h.answer(1, {});
    assert.equal(h.clients.length, 1);
  });

  it("once a feed exists Retry is the recovery owner's, and reads no settings", async () => {
    const h = harness();
    const run = h.lifecycle.start();
    await h.answer(0, {});
    await run;
    await h.started;
    assert.equal(h.lifecycle.retryNow(), false, "a running feed has nothing to retry");
    assert.deepEqual(h.sdkCalls, ["subscribe", "get"]);
  });
});

describe("createFeedLifecycle: one first client", () => {
  it("an outside change that also answers the read, and more changes, make one client", async () => {
    const h = harness();
    const run = h.lifecycle.start();
    await run;
    const read = h.reads[0];
    assert.ok(read);
    // As the SDK delivers one event: the subscription now, the read later.
    h.emitOutside({});
    read.resolve({});
    await read.done;
    h.emitOutside({ other: 1 });
    h.lifecycle.retryNow();
    assert.deepEqual(
      h.clients.map((entry) => entry.url),
      [DEFAULT],
    );
  });

  // C3b2: a new valid address now switches (connection-switch tests below);
  // settings that are not valid still change nothing active.
  it("after the feed started, malformed or invalid settings change nothing active", async () => {
    const h = harness();
    const run = h.lifecycle.start();
    await h.answer(0, {});
    await run;
    await h.started;
    const before = connection(h.lifecycle);
    h.emitOutside("malformed");
    h.emitOutside({ connection: { version: 1, daemonUrl: "ws://example.com:7200/ws" } });
    assert.equal(h.clients.length, 1, "no second client");
    assert.deepEqual(connection(h.lifecycle), before, "the active address is the one in use");
    assert.equal(h.clients[0]?.client.closed, 0, "the active feed keeps running");
    assert.deepEqual(h.lifecycle.facts().requested, {
      kind: "blocked",
      reason: "saved_invalid",
    });
  });
});

describe("createFeedLifecycle: shutdown during each step", () => {
  it("during the settings read: a later answer starts nothing", async () => {
    const h = harness();
    await h.lifecycle.start();
    h.beginShutdown();
    await h.answer(0, {});
    assert.equal(h.clients.length, 0);
    assert.deepEqual(connection(h.lifecycle), { kind: "loading" }, "never shown as active");
  });

  it("during the legacy read: its answer starts nothing", async () => {
    const legacy = deferred<LegacyFileRead>();
    const h = harness(legacy.promise);
    const run = h.lifecycle.start();
    await h.answer(0, {});
    h.beginShutdown();
    legacy.resolve({ kind: "missing" });
    await run;
    assert.equal(h.clients.length, 0);
    assert.equal(
      h.lines.some((line) => line.startsWith("legacy target:")),
      false,
      "the legacy file is not read yet",
    );
  });

  it("before start: nothing is read", async () => {
    const h = harness();
    h.beginShutdown();
    await h.lifecycle.start();
    assert.deepEqual([h.sdkCalls, h.legacyReads(), h.clients.length], [[], 0, 0]);
  });

  it("while the feed starts: stop closes its client and the reader; nothing starts after", async () => {
    const connect = deferred<undefined>();
    const h = harness(
      { kind: "missing" },
      connect.promise.then(() => undefined),
    );
    const run = h.lifecycle.start();
    await h.answer(0, {});
    await run;
    const client = h.clients[0]?.client;
    assert.ok(client, "the feed is starting, its connect held");
    assert.equal(client.connectCalls, 1);
    h.beginShutdown();
    const stopping = h.lifecycle.stop();
    connect.resolve(undefined);
    await stopping;
    assert.equal(client.closed, 1);
    assert.equal(h.sdkCalls.at(-1), "unsubscribe");
    h.emitOutside({ connection: { version: 1, daemonUrl: "ws://localhost:7300/ws" } });
    assert.equal(h.clients.length, 1, "nothing starts after stop");
  });
});

describe("createFeedLifecycle: isolation", () => {
  it("two lifecycles keep their own settings, sources and clients", async () => {
    const first = harness({ kind: "missing" });
    const second = harness(legacyText({ daemonUrl: "ws://localhost:7400/ws" }));
    const runFirst = first.lifecycle.start();
    const runSecond = second.lifecycle.start();
    await first.answer(0, { connection: { version: 1, daemonUrl: "ws://localhost:7500/ws" } });
    await second.answer(0, {});
    await runFirst;
    await runSecond;
    assert.deepEqual(
      first.clients.map((entry) => entry.url),
      ["ws://localhost:7500/ws"],
    );
    assert.deepEqual(
      second.clients.map((entry) => entry.url),
      ["ws://localhost:7400/ws"],
    );
    await first.lifecycle.stop();
    assert.equal(second.clients[0]?.client.closed, 0);
  });
});

describe("createFeedLifecycle: logging", () => {
  it("logs fixed codes only: the source and the E1 target kind, no address or file content", async () => {
    const h = harness(legacyText({ ...TARGET, daemonUrl: "ws://localhost:7600/ws" }));
    const run = h.lifecycle.start();
    await h.answer(0, {});
    await run;
    assert.ok(h.lines.includes("connection: legacy"));
    assert.ok(h.lines.includes("legacy target: ok"));
    assert.equal(
      h.lines.some((line) => line.includes("7600") || line.includes(TARGET.agentId)),
      false,
    );
  });

  it("logs only SDK levels from the client, as fixed codes", async () => {
    const h = harness();
    const run = h.lifecycle.start();
    await h.answer(0, {});
    await run;
    await h.started;
    const report = h.clients[0]?.report;
    assert.ok(report);
    report("error");
    report("warn");
    assert.deepEqual(h.lines.slice(-2), ["paseo client: error", "paseo client: warning"]);
  });
});

const address = (port: number) => `ws://localhost:${String(port)}/ws`;
const saved = (port: number) => ({ connection: { version: 1, daemonUrl: address(port) } });
const A = 7701;
const B = 7702;
const C = 7703;

type Harness = ReturnType<typeof harness>;

/** Starts on `settings` and waits until the first feed has started. */
async function running(h: Harness, settings: unknown): Promise<FakeClient> {
  const run = h.lifecycle.start();
  await h.answer(0, settings);
  await run;
  await h.started;
  const client = h.clients[0]?.client;
  assert.ok(client);
  return client;
}

/** Holds the client's close until the returned function is called. */
function holdClose(client: FakeClient): () => void {
  const gate = deferred<undefined>();
  client.closeGate = gate.promise.then(() => undefined);
  return () => {
    gate.resolve(undefined);
  };
}

const urls = (h: Harness) => h.clients.map((entry) => entry.url);
const view = (h: Harness) => connection(h.lifecycle).kind;
const startedFeeds = (h: Harness) => h.lines.filter((line) => line === "feed started").length;

describe("createFeedLifecycle: switching the address (C3b2)", () => {
  it("a confirmed close: the old client closes first, then one new client on the new address", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    const release = holdClose(old);
    const disposedAtCreate: boolean[] = [];
    h.configure(() => {
      disposedAtCreate.push(old.getConnectionState().status === "disposed");
    });
    h.emitOutside(saved(B));
    assert.equal(view(h), "switching", "never the new address before it is used");
    assert.equal(h.lifecycle.source().recovery, null, "the old owner is detached at once");
    assert.deepEqual(urls(h), [address(A)], "no new client while the old one closes");
    release();
    await h.until(() => startedFeeds(h) === 2);
    assert.deepEqual(urls(h), [address(A), address(B)]);
    assert.deepEqual(connection(h.lifecycle), {
      kind: "active",
      daemonUrl: address(B),
      source: "saved",
    });
    assert.deepEqual(disposedAtCreate, [true], "the old client was disposed before the new one");
    assert.ok(h.lines.includes("connection switch: closing"));
    assert.equal(
      h.lines.some((line) => line.includes(String(A)) || line.includes(String(B))),
      false,
      "no address in the log",
    );
  });

  it("an owner that never created a client (none): the switch goes on", async () => {
    const h = harness();
    h.configure((_client, url) => {
      if (url === address(A)) throw new Error("raw create");
    });
    const run = h.lifecycle.start();
    await h.answer(0, saved(A));
    await run;
    await h.until(() => h.lifecycle.source().recovery?.state.kind === "waiting");
    assert.equal(h.clients.length, 0);
    h.emitOutside(saved(B));
    await h.until(() => startedFeeds(h) === 1);
    assert.deepEqual(urls(h), [address(B)]);
  });

  it("a failed unsubscribe with a confirmed client close still switches", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    old.unsubscribeError = new Error("raw unsubscribe");
    h.emitOutside(saved(B));
    await h.until(() => startedFeeds(h) === 2);
    assert.deepEqual(urls(h), [address(A), address(B)]);
  });

  it("an unconfirmed client close blocks: no new client, Retry starts nothing, a restart is needed", async () => {
    for (const disposes of [true, false]) {
      const h = harness();
      const old = await running(h, saved(A));
      old.closeError = new Error("raw close");
      old.closeErrorDisposes = disposes;
      h.emitOutside(saved(B));
      await h.until(() => h.lines.includes("connection switch blocked: failed"));
      assert.equal(view(h), "switch_blocked");
      assert.equal(h.lifecycle.retryNow(), false, "Retry never makes a second owner");
      h.emitOutside(saved(C));
      assert.deepEqual(urls(h), [address(A)], "and no later address either");
      assert.equal(view(h), "switch_blocked");
      assert.equal(h.lines.includes("feed cleanup failed"), false, "the old owner's event is old");
      assert.doesNotMatch(h.lines.join("\n"), /raw/);
    }
  });

  it("a close cleanup that failed during an earlier retry keeps the switch blocked", async () => {
    const h = harness();
    let first = true;
    h.configure((client) => {
      if (!first) return;
      first = false;
      client.connectError = new Error("raw connect");
      client.closeError = new Error("raw close");
    });
    const run = h.lifecycle.start();
    await h.answer(0, saved(A));
    await run;
    await h.until(() => h.lifecycle.source().recovery?.state.kind === "waiting");
    assert.ok(h.lines.includes("feed cleanup failed"));
    assert.equal(h.lifecycle.retryNow(), true);
    await h.until(() => startedFeeds(h) === 1);
    h.emitOutside(saved(B));
    await h.until(() => h.lines.includes("connection switch blocked: failed"));
    assert.equal(h.clients[1]?.client.closed, 1, "the retried client closed cleanly");
    assert.deepEqual(urls(h), [address(A), address(A)], "no client on the new address");
    assert.equal(view(h), "switch_blocked");
  });

  it("a close past its deadline blocks; a late confirmed close starts the newest address", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    const release = holdClose(old);
    h.emitOutside(saved(B));
    h.clock.advance(SWITCH_CLOSE_TIMEOUT_MS - 1);
    assert.equal(view(h), "switching");
    h.clock.advance(1);
    await h.until(() => view(h) === "switch_blocked");
    assert.equal(h.lifecycle.retryNow(), false);
    h.emitOutside(saved(C));
    assert.deepEqual(urls(h), [address(A)]);
    release();
    await h.until(() => startedFeeds(h) === 2);
    assert.deepEqual(urls(h), [address(A), address(C)]);
    assert.equal(view(h), "active");
  });

  it("a close past its deadline that then fails stays blocked", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    const release = holdClose(old);
    old.closeError = new Error("raw close");
    h.emitOutside(saved(B));
    h.clock.advance(SWITCH_CLOSE_TIMEOUT_MS);
    await h.until(() => view(h) === "switch_blocked");
    release();
    await h.until(() => h.lines.includes("connection switch blocked: failed"));
    assert.deepEqual(urls(h), [address(A)]);
    assert.equal(view(h), "switch_blocked");
  });

  it("A to B to C while A closes: A closes once, only C starts", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    const release = holdClose(old);
    h.emitOutside(saved(B));
    h.emitOutside(saved(C));
    release();
    await h.until(() => startedFeeds(h) === 2);
    assert.deepEqual(urls(h), [address(A), address(C)]);
    assert.equal(old.closed, 1);
  });

  it("A to B to A while A closes: the old owner is never revived; a new client on A", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    const release = holdClose(old);
    h.emitOutside(saved(B));
    h.emitOutside(saved(A));
    assert.equal(view(h), "switching", "A is not shown again before its new client runs");
    release();
    await h.until(() => startedFeeds(h) === 2);
    assert.deepEqual(urls(h), [address(A), address(A)]);
    assert.notEqual(h.clients[1]?.client, old);
    assert.equal(old.closed, 1);
  });

  it("the same address never restarts; a source-only change only updates the source", async () => {
    const h = harness(legacyText({ daemonUrl: address(A) }));
    await running(h, {});
    assert.deepEqual(connection(h.lifecycle), {
      kind: "active",
      daemonUrl: address(A),
      source: "legacy",
    });
    h.emitOutside(saved(A));
    assert.deepEqual(connection(h.lifecycle), {
      kind: "active",
      daemonUrl: address(A),
      source: "saved",
    });
    h.emitOutside({});
    assert.deepEqual(connection(h.lifecycle), {
      kind: "active",
      daemonUrl: address(A),
      source: "legacy",
    });
    assert.deepEqual(urls(h), [address(A)]);
    assert.equal(h.clients[0]?.client.closed, 0);
  });

  it("the same address while the owner waits for Retry: no restart", async () => {
    const h = harness();
    let first = true;
    h.configure((client) => {
      if (first) client.connectError = new Error("raw connect");
      first = false;
    });
    const run = h.lifecycle.start();
    await h.answer(0, {});
    await run;
    await h.until(() => h.lifecycle.source().recovery?.state.kind === "waiting");
    const owner = h.lifecycle.source().recovery;
    h.emitOutside({ connection: { version: 1, daemonUrl: DEFAULT } });
    assert.equal(h.lifecycle.source().recovery, owner, "the same owner");
    assert.deepEqual(connection(h.lifecycle), {
      kind: "active",
      daemonUrl: DEFAULT,
      source: "saved",
    });
    assert.equal(h.clients.length, 1);
  });

  it("removing the saved key chooses the legacy address read at start, or the default", async () => {
    const withLegacy = harness(legacyText({ daemonUrl: address(A) }));
    await running(withLegacy, saved(B));
    withLegacy.emitOutside({});
    await withLegacy.until(() => startedFeeds(withLegacy) === 2);
    assert.deepEqual(urls(withLegacy), [address(B), address(A)]);
    assert.equal(withLegacy.legacyReads(), 1, "the file is not read again");

    const withoutLegacy = harness({ kind: "missing" });
    await running(withoutLegacy, saved(B));
    withoutLegacy.emitOutside({ unrelated: true });
    await withoutLegacy.until(() => startedFeeds(withoutLegacy) === 2);
    assert.deepEqual(urls(withoutLegacy), [address(B), DEFAULT]);
  });

  it("removing the key when the legacy choice is blocked keeps the active connection", async () => {
    const h = harness({ kind: "unreadable" });
    await running(h, saved(B));
    h.emitOutside({});
    assert.deepEqual(connection(h.lifecycle), {
      kind: "active",
      daemonUrl: address(B),
      source: "saved",
    });
    assert.deepEqual(h.lifecycle.facts().requested, {
      kind: "blocked",
      reason: "legacy_unreadable",
    });
    assert.equal(h.clients[0]?.client.closed, 0);
  });

  it("an invalid event before a switch keeps A; a later valid address still switches", async () => {
    const h = harness();
    await running(h, saved(A));
    h.emitOutside("malformed");
    assert.equal(view(h), "active");
    h.emitOutside(saved(B));
    await h.until(() => startedFeeds(h) === 2);
    assert.deepEqual(urls(h), [address(A), address(B)]);
  });

  it("an invalid event during a switch: B never starts; the source error is shown, not switch_blocked", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    const release = holdClose(old);
    h.emitOutside(saved(B));
    h.emitOutside({ connection: null });
    const closedBefore = h.renders();
    release();
    await h.until(() => h.renders() > closedBefore);
    assert.deepEqual(connection(h.lifecycle), { kind: "blocked", reason: "saved_invalid" });
    assert.deepEqual(urls(h), [address(A)]);
    assert.equal(h.lifecycle.retryNow(), false, "a bad source needs a fix");
    h.emitOutside(saved(C));
    await h.until(() => startedFeeds(h) === 2);
    assert.deepEqual(urls(h), [address(A), address(C)]);
  });

  it("callbacks of the old owner after the switch began do nothing", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    const report = h.clients[0]?.report;
    assert.ok(report);
    const release = holdClose(old);
    const before = h.renders();
    h.emitOutside(saved(B));
    assert.equal(
      h.renders(),
      before + 2,
      "the settings change and the switch, nothing from the old owner",
    );
    const lines = h.lines.length;
    report("error");
    old.emitSnapshot({ entries: [], pageInfo: { hasMore: false } });
    assert.equal(h.lines.length, lines, "the old client logs nothing");
    release();
    await h.until(() => startedFeeds(h) === 2);
    assert.equal(h.lines.includes("paseo client: error"), false);
  });
});

describe("createFeedLifecycle: shutdown during a switch (C3b2)", () => {
  it("while the old client closes: stop waits for it; nothing starts or draws; the deadline is cancelled", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    const release = holdClose(old);
    h.emitOutside(saved(B));
    h.beginShutdown();
    const renders = h.renders();
    // What stop has seen of the old client when it resolves.
    const stopping = h.lifecycle.stop().then(() => old.getConnectionState().status);
    assert.equal(h.clock.pendingTimers, 0, "the switch deadline is cancelled");
    release();
    assert.equal(await stopping, "disposed", "stop resolved only after the close finished");
    assert.deepEqual(urls(h), [address(A)]);
    assert.equal(h.renders(), renders, "a close that finishes after shutdown draws nothing");
  });

  it("a deadline that passes after shutdown began blocks nothing", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    const release = holdClose(old);
    old.closeError = new Error("raw close");
    h.emitOutside(saved(B));
    h.beginShutdown();
    h.clock.advance(SWITCH_CLOSE_TIMEOUT_MS);
    const stopping = h.lifecycle.stop();
    release();
    await stopping;
    assert.equal(
      h.lines.some((line) => line.startsWith("connection switch blocked")),
      false,
      "neither the timeout nor the failed close is reported after shutdown",
    );
    assert.notEqual(view(h), "switch_blocked");
    assert.deepEqual(urls(h), [address(A)]);
  });

  it("stop alone, before the shutdown flag, also starts nothing after a late close", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    const release = holdClose(old);
    h.emitOutside(saved(B));
    const stopping = h.lifecycle.stop();
    release();
    await stopping;
    assert.deepEqual(urls(h), [address(A)]);
    assert.equal(h.sdkCalls.at(-1), "unsubscribe");
  });

  it("after the deadline passed: a late close starts nothing", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    const release = holdClose(old);
    h.emitOutside(saved(B));
    h.clock.advance(SWITCH_CLOSE_TIMEOUT_MS);
    await h.until(() => view(h) === "switch_blocked");
    h.beginShutdown();
    const stopping = h.lifecycle.stop();
    release();
    await stopping;
    assert.deepEqual(urls(h), [address(A)]);
  });

  it("after a failed close, and after the new feed runs: stop ends cleanly", async () => {
    const blocked = harness();
    const old = await running(blocked, saved(A));
    old.closeError = new Error("raw close");
    blocked.emitOutside(saved(B));
    await blocked.until(() => view(blocked) === "switch_blocked");
    blocked.beginShutdown();
    await blocked.lifecycle.stop();
    assert.deepEqual(urls(blocked), [address(A)]);

    const switched = harness();
    await running(switched, saved(A));
    switched.emitOutside(saved(B));
    await switched.until(() => startedFeeds(switched) === 2);
    switched.beginShutdown();
    await switched.lifecycle.stop();
    assert.equal(switched.clients[1]?.client.closed, 1, "the new client is closed");
  });

  it("a settings change after shutdown began starts no switch", async () => {
    const h = harness();
    const old = await running(h, saved(A));
    h.beginShutdown();
    h.emitOutside(saved(B));
    assert.equal(old.closed, 0, "the switch is not begun; stop closes it");
    assert.equal(view(h), "active");
  });
});
