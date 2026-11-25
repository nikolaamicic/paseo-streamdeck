import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ActiveConnection, JsonObject } from "../../src/connection/connection-save.ts";
import { ConnectionSaver, type SaveOutcome } from "../../src/connection/connection-saver.ts";
import {
  GlobalSettingsReader,
  SETTINGS_READ_TIMEOUT_MS,
} from "../../src/connection/settings-reader.ts";
import { deferred, ManualScheduler } from "../support/fake-client.ts";

/**
 * The Save owner (C4a1) with the real GlobalSettingsReader, a fake SDK
 * (reads, outside changes and writes the test settles) and a manual clock.
 * No real SDK, settings, lifecycle or daemon: `active` is a plain fact.
 */

const A = "ws://localhost:7001/ws";
const B = "ws://localhost:7002/ws";
const C = "ws://localhost:7003/ws";
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

function setup() {
  const clock = new ManualScheduler();
  const reads: { resolve: (value: unknown) => void; reject: () => void; done: Promise<unknown> }[] =
    [];
  const writes: Write[] = [];
  let listener: ((settings: unknown) => void) | null = null;
  let changes = 0;
  let throwOnWrite = false;
  /** Runs inside the reader's onChange, as a synchronous listener would. */
  let onReaderChange: (() => void) | null = null;
  /** Runs inside setGlobalSettings, before it returns. */
  let onSend: (() => void) | null = null;
  let active: ActiveConnection | null = null;
  const reader = new GlobalSettingsReader({
    getGlobalSettings: () => {
      const read = deferred<unknown>();
      let reject: () => void = () => undefined;
      const done = new Promise<unknown>((resolve, fail) => {
        read.promise.then(resolve, fail);
        reject = () => {
          fail(new Error("refused"));
        };
      });
      reads.push({ resolve: read.resolve, reject, done });
      return done;
    },
    subscribe: (next) => {
      listener = next;
      return {
        dispose: () => {
          listener = null;
        },
      };
    },
    timers: clock,
    onChange: () => {
      changes += 1;
      onReaderChange?.();
    },
  });
  const saver = new ConnectionSaver({
    reader,
    active: () => active,
    setGlobalSettings: (settings) => {
      onSend?.();
      if (throwOnWrite) throw new Error("sync");
      const sent = deferred<"ok" | "refused">();
      const outcome = sent.promise.then((result) => {
        if (result === "refused") throw new Error("refused");
      });
      writes.push({
        settings,
        accept: async () => {
          sent.resolve("ok");
          await outcome;
        },
        refuse: async () => {
          sent.resolve("refused");
          await outcome.catch(() => undefined);
        },
      });
      return outcome;
    },
  });
  const h = {
    clock,
    reader,
    saver,
    reads,
    writes,
    changes: () => changes,
    setActive: (next: ActiveConnection | null) => {
      active = next;
    },
    throwOnWrite: () => {
      throwOnWrite = true;
    },
    /** Runs `hook` once inside the next reader onChange. */
    onNextReaderChange: (hook: () => void) => {
      onReaderChange = () => {
        onReaderChange = null;
        hook();
      };
    },
    /** Runs `hook` once inside the next setGlobalSettings call. */
    onNextSend: (hook: () => void) => {
      onSend = () => {
        onSend = null;
        hook();
      };
    },
    emitOutside: (settings: unknown) => {
      listener?.(settings);
    },
    /** Starts the reader and answers its first read with `settings`. */
    loaded: async (settings: unknown) => {
      reader.start();
      const read = reads[0];
      assert.ok(read);
      read.resolve(settings);
      await read.done;
    },
  };
  cleanups.push(async () => {
    saver.dispose();
    reader.dispose();
    // Settles every write the test left open; an already refused one stays refused.
    for (const write of writes) await write.accept().catch(() => undefined);
    for (const read of reads) {
      read.resolve({});
      await read.done.catch(() => undefined);
    }
    assert.equal(clock.pendingTimers, 0, "no timer left");
  });
  return h;
}

/** A Save whose outcome the test can look at without awaiting it. */
function track(promise: Promise<SaveOutcome>) {
  const seen: { outcome: SaveOutcome | null } = { outcome: null };
  const done = promise.then((outcome) => {
    seen.outcome = outcome;
    return outcome;
  });
  return { seen, done };
}

describe("ConnectionSaver", () => {
  it("creating it reads, writes and schedules nothing", () => {
    const h = setup();
    assert.deepEqual([h.reads.length, h.writes.length, h.clock.pendingTimers], [0, 0, 0]);
    assert.equal(h.saver.sent, null);
  });

  it("invalid input writes nothing and changes nothing known", async () => {
    const h = setup();
    await h.loaded(saved(A));
    const revision = h.reader.state.revision;
    assert.deepEqual(await h.saver.save("ws://localhost:0/ws"), {
      kind: "invalid",
      error: "invalid_format",
    });
    assert.deepEqual(await h.saver.save(undefined), { kind: "invalid", error: "not_string" });
    assert.equal(h.writes.length, 0);
    assert.equal(h.reader.state.revision, revision);
  });

  it("no reliable base: nothing read yet, or malformed settings, block the write", async () => {
    const none = setup();
    none.reader.start();
    assert.deepEqual(await none.saver.save(A), { kind: "not_loaded" });
    none.clock.advance(SETTINGS_READ_TIMEOUT_MS);
    assert.equal(none.reader.state.read, "timed_out");
    assert.deepEqual(await none.saver.save(A), { kind: "not_loaded" });

    const malformed = setup();
    await malformed.loaded(["not", "an", "object"]);
    assert.deepEqual(await malformed.saver.save(A), { kind: "malformed" });
    assert.equal(none.writes.length + malformed.writes.length, 0);
  });

  it("a pending, failed or timed-out new read keeps the earlier reliable base", async () => {
    const h = setup();
    await h.loaded({ keep: 1 });
    h.reader.retry();
    assert.equal(h.reader.state.read, "pending");
    const pending = track(h.saver.save(A));
    assert.deepEqual(h.writes[0]?.settings, { keep: 1, ...saved(A) });
    await h.writes[0].accept();
    assert.deepEqual(await pending.done, { kind: "sent" });

    // The read still in flight was issued before the write: stale.
    h.reads[1]?.resolve({ keep: "old" });
    await h.reads[1]?.done;
    assert.deepEqual(h.reader.state.known, { kind: "loaded", settings: { keep: 1, ...saved(A) } });

    h.reader.retry();
    h.reads[2]?.reject();
    await h.reads[2]?.done.catch(() => undefined);
    assert.equal(h.reader.state.read, "failed");
    const failed = track(h.saver.save(B));
    assert.equal(h.writes.length, 2, "a failed read keeps the base");
    await h.writes[1]?.accept();
    assert.deepEqual(await failed.done, { kind: "sent" });

    h.reader.retry();
    h.clock.advance(SETTINGS_READ_TIMEOUT_MS);
    assert.equal(h.reader.state.read, "timed_out");
    const timedOut = track(h.saver.save(C));
    assert.equal(h.writes.length, 3, "a timed-out read keeps the base");
    await h.writes[2]?.accept();
    assert.deepEqual(await timedOut.done, { kind: "sent" });
  });

  it("the saved and active address is a no-op; an already saved inactive one is not written", async () => {
    const h = setup();
    await h.loaded(saved(A));
    h.setActive({ daemonUrl: A, source: "saved" });
    assert.deepEqual(await h.saver.save(A), { kind: "unchanged" });
    h.setActive({ daemonUrl: B, source: "saved" });
    assert.deepEqual(await h.saver.save(A), { kind: "saved_not_active" });
    h.setActive(null);
    assert.deepEqual(await h.saver.save(A), { kind: "saved_not_active" });
    assert.equal(h.writes.length, 0);
  });

  it("an active legacy or default address is written and becomes known as sent, keeping other keys", async () => {
    for (const source of ["legacy", "default"] as const) {
      const h = setup();
      await h.loaded({ other: { a: [1, 2] } });
      h.setActive({ daemonUrl: A, source });
      const saving = h.saver.save(A);
      assert.deepEqual(h.reader.state.known, {
        kind: "loaded",
        settings: { other: { a: [1, 2] } },
      });
      assert.equal(h.saver.sent, null, "nothing is sent before the SDK took it");
      await h.writes[0]?.accept();
      assert.deepEqual(await saving, { kind: "sent" });
      assert.deepEqual(h.reader.state.known, {
        kind: "loaded",
        settings: { other: { a: [1, 2] }, ...saved(A) },
      });
      assert.deepEqual(h.saver.sent, { daemonUrl: A, confirmed: false });
      h.emitOutside(saved(A));
      assert.equal(h.saver.sent, null, "a newer state is a read, not our unconfirmed write");
    }
  });

  it("a refused or throwing send changes nothing known", async () => {
    const refused = setup();
    await refused.loaded({ k: 1 });
    const saving = refused.saver.save(A);
    await refused.writes[0]?.refuse();
    assert.deepEqual(await saving, { kind: "not_sent" });
    assert.deepEqual(refused.reader.state.known, { kind: "loaded", settings: { k: 1 } });
    assert.equal(refused.saver.sent, null);

    const thrown = setup();
    await thrown.loaded({ k: 1 });
    thrown.throwOnWrite();
    assert.deepEqual(await thrown.saver.save(A), { kind: "not_sent" });
    assert.deepEqual(thrown.reader.state.known, { kind: "loaded", settings: { k: 1 } });
  });

  it("an outside change with another address during the send is kept; the Save reports it", async () => {
    const h = setup();
    await h.loaded({});
    const saving = h.saver.save(A);
    h.emitOutside({ ...saved(B), x: 1 });
    await h.writes[0]?.accept();
    assert.deepEqual(await saving, { kind: "sent_superseded" });
    assert.deepEqual(h.reader.state.known, { kind: "loaded", settings: { ...saved(B), x: 1 } });
    assert.equal(h.saver.sent, null);
  });

  it("an echo of the same address during the send is no conflict and applies once", async () => {
    const echoed = setup();
    await echoed.loaded({});
    const saving = echoed.saver.save(A);
    const before = echoed.reader.state.revision;
    echoed.emitOutside(saved(A));
    await echoed.writes[0]?.accept();
    assert.deepEqual(await saving, { kind: "sent" });
    assert.equal(echoed.reader.state.revision, before + 1, "the echo applied, the write not again");

    const quiet = setup();
    await quiet.loaded({});
    const alone = quiet.saver.save(A);
    const start = quiet.reader.state.revision;
    await quiet.writes[0]?.accept();
    assert.deepEqual(await alone, { kind: "sent" });
    assert.equal(quiet.reader.state.revision, start + 1, "without an echo, applied once");
  });

  it("one running and one waiting Save: a newer one replaces the waiting one, decided when it runs", async () => {
    const h = setup();
    await h.loaded({ v: 1 });
    const first = track(h.saver.save(A));
    const second = track(h.saver.save(B));
    const third = track(h.saver.save(C));
    assert.deepEqual(await second.done, { kind: "replaced" });
    assert.equal(h.writes.length, 1, "the waiting Save has not started");
    assert.equal(third.seen.outcome, null);
    // A newer state arrives before the waiting Save runs.
    h.emitOutside({ v: 2 });
    await h.writes[0]?.accept();
    assert.deepEqual(await first.done, { kind: "sent_superseded" });
    assert.deepEqual(h.writes[1]?.settings, { v: 2, ...saved(C) }, "built from the newest state");
    await h.writes[1].accept();
    assert.deepEqual(await third.done, { kind: "sent" });
    assert.equal(h.writes.length, 2);
  });

  it("a waiting Save is decided again when it runs: it may write nothing", async () => {
    const h = setup();
    await h.loaded({});
    const first = track(h.saver.save(A));
    const waiting = track(h.saver.save(B));
    h.emitOutside(saved(B));
    await h.writes[0]?.accept();
    await first.done;
    assert.deepEqual(await waiting.done, { kind: "saved_not_active" });
    const invalid = track(h.saver.save(A));
    const after = track(h.saver.save("bad"));
    await h.writes[1]?.accept();
    await invalid.done;
    assert.deepEqual(await after.done, { kind: "invalid", error: "invalid_format" });
    assert.equal(h.writes.length, 2);
  });

  it("dispose settles the running and waiting Saves; a late SDK result changes nothing", async () => {
    const h = setup();
    await h.loaded({ k: 1 });
    const running = track(h.saver.save(A));
    const waiting = track(h.saver.save(B));
    h.saver.dispose();
    assert.deepEqual(await running.done, { kind: "stopped" });
    assert.deepEqual(await waiting.done, { kind: "stopped" });
    const changes = h.changes();
    const revision = h.reader.state.revision;
    await h.writes[0]?.accept();
    assert.deepEqual(h.reader.state.known, { kind: "loaded", settings: { k: 1 } });
    assert.equal(h.reader.state.revision, revision);
    assert.equal(h.changes(), changes, "no callback after dispose");
    assert.deepEqual(await h.saver.save(C), { kind: "stopped" });
    assert.equal(h.writes.length, 1, "nothing more is sent");
  });

  it("a disposed reader begins no write", async () => {
    const h = setup();
    await h.loaded({});
    h.reader.dispose();
    assert.deepEqual(await h.saver.save(A), { kind: "stopped" });
    assert.equal(h.writes.length, 0);
  });

  describe("synchronous callbacks around the send", () => {
    it("no reader callback runs between the snapshot and the send; a newer state is never overwritten", async () => {
      const h = setup();
      await h.loaded({ keep: "old" });
      // A listener that delivers a newer state on the reader's next callback.
      h.onNextReaderChange(() => {
        h.emitOutside({ keep: "new" });
      });
      const changes = h.changes();
      const saving = h.saver.save(A);
      assert.equal(h.changes(), changes, "beginWrite is silent: no callback before the send");
      assert.deepEqual(h.writes[0]?.settings, { keep: "old", ...saved(A) });
      // The callback runs when the accepted write is applied; its newer state wins.
      await h.writes[0].accept();
      assert.deepEqual(await saving, { kind: "sent_superseded" });
      assert.deepEqual(h.reader.state.known, { kind: "loaded", settings: { keep: "new" } });
      assert.equal(h.saver.sent, null, "the sent address is not claimed as known");
    });

    it("a callback during the applied write that keeps the address: sent, but not our object", async () => {
      const h = setup();
      await h.loaded({});
      h.onNextReaderChange(() => {
        h.emitOutside({ ...saved(A), other: 1 });
      });
      const saving = h.saver.save(A);
      await h.writes[0]?.accept();
      assert.deepEqual(await saving, { kind: "sent" });
      assert.deepEqual(h.reader.state.known, {
        kind: "loaded",
        settings: { ...saved(A), other: 1 },
      });
      assert.equal(h.saver.sent, null, "what is known is the newer state, not the write");
    });

    it("dispose during the reader callback of an applied write: stopped, nothing recorded or sent", async () => {
      const h = setup();
      await h.loaded({});
      h.onNextReaderChange(() => {
        h.saver.dispose();
        h.reader.dispose();
      });
      const saving = h.saver.save(A);
      const queued = h.saver.save(B);
      await h.writes[0]?.accept();
      assert.deepEqual(await saving, { kind: "stopped" });
      assert.deepEqual(await queued, { kind: "stopped" });
      assert.equal(h.saver.sent, null);
      assert.equal(h.writes.length, 1, "the waiting Save is never sent");
    });

    it("dispose inside setGlobalSettings: stopped; the late result changes nothing", async () => {
      const h = setup();
      await h.loaded({ k: 1 });
      h.onNextSend(() => {
        h.saver.dispose();
      });
      const saving = h.saver.save(A);
      assert.deepEqual(await saving, { kind: "stopped" });
      const revision = h.reader.state.revision;
      await h.writes[0]?.accept();
      assert.equal(h.reader.state.revision, revision);
      assert.deepEqual(h.reader.state.known, { kind: "loaded", settings: { k: 1 } });
    });

    it("a reentrant save during the send or during the reader callback waits, then runs from fresh state", async () => {
      const h = setup();
      await h.loaded({ v: 1 });
      const reentrant: { send?: Promise<SaveOutcome>; callback?: Promise<SaveOutcome> } = {};
      h.onNextSend(() => {
        reentrant.send = h.saver.save(B);
      });
      const first = h.saver.save(A);
      assert.equal(h.writes.length, 1, "the reentrant Save did not start a second write");
      h.onNextReaderChange(() => {
        reentrant.callback = h.saver.save(C);
      });
      await h.writes[0]?.accept();
      assert.deepEqual(await first, { kind: "sent" });
      assert.deepEqual(await reentrant.send, { kind: "replaced" }, "replaced by the newer one");
      assert.deepEqual(h.writes[1]?.settings, { v: 1, ...saved(C) }, "built after the first write");
      await h.writes[1].accept();
      assert.deepEqual(await reentrant.callback, { kind: "sent" });
      assert.equal(h.writes.length, 2);
    });
  });
});
