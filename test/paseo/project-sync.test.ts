import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeedWarningCode } from "../../src/paseo/feed-diagnostics.ts";
import {
  MAX_BUFFERED_PROJECT_UPDATES,
  MAX_SYNC_REFRESHES,
  ProjectDirectorySync,
} from "../../src/paseo/project-sync.ts";
import { deferred, FakeEventSubscription } from "../support/fake-client.ts";
import { SERVER_ID } from "../support/fixtures.ts";

/**
 * The project list (P1): projects.list plus ordered project.update events
 * over a fake event subscription and list requests the test settles. One
 * explicit signal (until) instead of a flush. Synthetic names only.
 */

const OTHER_HOST = "srv_OtherHost02";
const descriptor = (projectId: string, name: string) => ({
  projectId,
  projectDisplayName: name,
  projectRootPath: "/tmp/synthetic",
  projectKind: "git",
});
const list = (generation: string | null, headSeq: number, ...projects: [string, string][]) => ({
  requestId: "r",
  projects: projects.map(([id, name]) => descriptor(id, name)),
  ...(generation === null ? {} : { sync: { generation, headSeq, mode: "snapshot", removals: [] } }),
});
const upsert = (id: string, name: string, generation: string | null, seq: number) => ({
  kind: "upsert",
  project: descriptor(id, name),
  ...(generation === null ? {} : { generation, seq }),
});
const remove = (id: string, generation: string, seq: number) => ({
  kind: "remove",
  projectId: id,
  generation,
  seq,
});

function setup(options: { activeOnSubscribe?: boolean; observeThrows?: boolean } = {}) {
  const events = new FakeEventSubscription();
  events.activeOnSubscribe = options.activeOnSubscribe ?? true;
  const requests: {
    options: unknown;
    resolve: (value: unknown) => void;
    reject: () => void;
    done: Promise<unknown>;
  }[] = [];
  const warnings: FeedWarningCode[] = [];
  let changes = 0;
  const waiters: { ready: () => boolean; resolve: () => void }[] = [];
  const check = () => {
    for (const waiter of waiters.splice(0)) {
      if (waiter.ready()) waiter.resolve();
      else waiters.push(waiter);
    }
  };
  const sync = new ProjectDirectorySync({
    client: {
      observeEvents: () => {
        if (options.observeThrows === true) throw new Error("raw");
        return events.handle();
      },
      projects: {
        list: (options: unknown) => {
          const answer = deferred<unknown>();
          let reject: () => void = () => undefined;
          const done = new Promise<unknown>((resolve, fail) => {
            answer.promise.then(resolve, fail);
            reject = () => {
              fail(new Error("raw list error"));
            };
          });
          requests.push({ options, resolve: answer.resolve, reject, done });
          check();
          return done;
        },
      },
    },
    onChange: () => {
      changes += 1;
      check();
    },
    warn: (code) => warnings.push(code),
  });
  const h = {
    sync,
    events,
    requests,
    warnings,
    changes: () => changes,
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
    /** Answers list request `index` and waits until the sync handled it. */
    answer: async (index: number, payload: unknown) => {
      await h.until(() => requests.length > index);
      const request = requests[index];
      assert.ok(request);
      const before = changes;
      request.resolve(payload);
      await request.done;
      await h.until(() => changes > before);
    },
    /** Answers a request whose result must be dropped (an older epoch or host). */
    answerStale: async (index: number, payload: unknown) => {
      await h.until(() => requests.length > index);
      const request = requests[index];
      assert.ok(request);
      request.resolve(payload);
      await request.done;
    },
    refuse: async (index: number) => {
      await h.until(() => requests.length > index);
      const request = requests[index];
      assert.ok(request);
      request.reject();
      await request.done.catch(() => undefined);
      await h.until(() => sync.state.status === "unavailable");
    },
    names: () =>
      sync.state.projects.map((project) => `${project.address.projectId}=${project.name}`).sort(),
  };
  return h;
}

describe("ProjectDirectorySync: the list and its updates", () => {
  it("subscribes first, then reads the list; an empty project is in it; ready and current", async () => {
    const h = setup();
    assert.deepEqual(
      [h.requests.length, h.sync.state.status],
      [0, "loading"],
      "creating does nothing",
    );
    h.sync.start(SERVER_ID);
    assert.equal(h.events.observers.size, 1, "subscribed before reading");
    await h.answer(0, list("g1", 3, ["p-alpha", "Project Alpha"], ["p-gamma", "Project Gamma"]));
    assert.deepEqual(h.names(), ["p-alpha=Project Alpha", "p-gamma=Project Gamma"]);
    assert.deepEqual([h.sync.state.status, h.sync.state.current], ["ready", true]);
    assert.equal(h.sync.state.projects[0]?.address.serverId, SERVER_ID);
  });

  it("projects with the same name stay apart", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, list("g1", 0, ["p-1", "Same"], ["p-2", "Same"]));
    assert.deepEqual(h.names(), ["p-1=Same", "p-2=Same"]);
  });

  it("ordered updates rename and remove; an old or duplicate seq is dropped", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, list("g1", 5, ["p-alpha", "Project Alpha"], ["p-beta", "Project Beta"]));
    h.events.emit(upsert("p-alpha", "Renamed Alpha", "g1", 6));
    h.events.emit(upsert("p-alpha", "Old Alpha", "g1", 6));
    h.events.emit(upsert("p-alpha", "Older Alpha", "g1", 4));
    h.events.emit(remove("p-beta", "g1", 9));
    h.events.emit(upsert("p-beta", "Revived Beta", "g1", 8));
    assert.deepEqual(h.names(), ["p-alpha=Renamed Alpha"]);
    assert.equal(h.sync.state.status, "ready");
  });

  it("updates buffered while the list is read are applied after it, older ones dropped", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    // Arrive before the list: one already in it (seq 2), one newer (seq 4).
    h.events.emit(upsert("p-alpha", "Stale Alpha", "g1", 2));
    h.events.emit(upsert("p-delta", "Project Delta", "g1", 4));
    h.events.emit(remove("p-gamma", "g1", 1));
    await h.answer(0, list("g1", 3, ["p-alpha", "Project Alpha"], ["p-gamma", "Project Gamma"]));
    assert.deepEqual(h.names(), [
      "p-alpha=Project Alpha",
      "p-delta=Project Delta",
      "p-gamma=Project Gamma",
    ]);
  });

  it("too many buffered updates read the list again", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    for (let seq = 1; seq <= MAX_BUFFERED_PROJECT_UPDATES + 1; seq += 1) {
      h.events.emit(upsert("p-alpha", `Alpha ${String(seq)}`, "g1", seq));
    }
    await h.answer(0, list("g1", 0, ["p-alpha", "Project Alpha"]));
    assert.equal(h.sync.state.status, "refreshing");
    await h.answer(1, list("g1", 300, ["p-alpha", "Alpha 300"]));
    assert.deepEqual([h.names(), h.sync.state.status], [["p-alpha=Alpha 300"], "ready"]);
  });

  it("an update of another generation or without a position reads the list again; one read at a time", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, list("g1", 1, ["p-alpha", "Project Alpha"]));
    h.events.emit(upsert("p-alpha", "Other generation", "g2", 1));
    assert.equal(h.sync.state.status, "refreshing");
    await h.until(() => h.requests.length === 2);
    // Another trigger while that read runs: queued once, not a parallel read.
    h.events.reactivate();
    assert.equal(h.requests.length, 2, "no parallel read");
    await h.answerStale(1, list("g2", 1, ["p-alpha", "Dropped: older epoch"]));
    await h.answer(2, list("g2", 1, ["p-alpha", "Alpha g2"]));
    assert.deepEqual([h.names(), h.sync.state.status], [["p-alpha=Alpha g2"], "ready"]);
    h.events.emit(upsert("p-alpha", "No position", null, 0));
    assert.equal(h.sync.state.status, "refreshing", "an unorderable update is not applied");
    await h.answer(3, list("g2", 2, ["p-alpha", "Alpha g2"]));
    assert.deepEqual(h.names(), ["p-alpha=Alpha g2"]);
  });

  it("updates that never fit the list end unavailable after a bounded number of reads; Retry starts over", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, list("g1", 0, ["p-alpha", "Project Alpha"]));
    for (let round = 1; round <= MAX_SYNC_REFRESHES; round += 1) {
      h.events.emit(upsert("p-alpha", "x", `gx${String(round)}`, 1));
      await h.answer(round, list("g1", 0, ["p-alpha", "Project Alpha"]));
    }
    h.events.emit(upsert("p-alpha", "x", "gx-last", 1));
    assert.equal(h.sync.state.status, "unavailable");
    assert.ok(h.warnings.includes("project_sync_failed"));
    const reads = h.requests.length;
    h.events.emit(upsert("p-alpha", "y", "gy", 1));
    assert.equal(h.requests.length, reads, "no further reads until Retry");
    assert.equal(h.sync.retry(), true);
    await h.answer(reads, list("g3", 1, ["p-alpha", "Alpha g3"]));
    assert.equal(h.sync.state.status, "ready");
    h.events.emit(upsert("p-alpha", "Applied", "g3", 2));
    assert.deepEqual(h.names(), ["p-alpha=Applied"]);
  });
});

describe("ProjectDirectorySync: degraded states and Retry", () => {
  it("a list without a sync position is shown as not current; updates are ignored; Retry reads again", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, list(null, 0, ["p-alpha", "Project Alpha"]));
    assert.deepEqual([h.sync.state.status, h.sync.state.current], ["unsynchronized", false]);
    assert.ok(h.warnings.includes("project_sync_missing"));
    h.events.emit(upsert("p-alpha", "Unordered", null, 0));
    assert.deepEqual(h.names(), ["p-alpha=Project Alpha"], "no unordered rename");
    assert.equal(h.sync.retry(), true);
    await h.answer(1, list("g1", 0, ["p-alpha", "Project Alpha"]));
    assert.equal(h.sync.state.status, "ready");
  });

  it("a failed list is unavailable; Retry reads again", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.refuse(0);
    assert.deepEqual([h.sync.state.status, h.sync.state.current], ["unavailable", false]);
    assert.ok(h.warnings.includes("project_list_failed"));
    assert.equal(h.sync.retry(), true);
    await h.answer(1, list("g1", 0, ["p-alpha", "Project Alpha"]));
    assert.equal(h.sync.state.status, "ready");
    assert.equal(h.sync.retry(), false, "nothing to retry when ready");
  });

  it("a subscription that fails after the list: not live, projects kept; Retry subscribes again", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, list("g1", 0, ["p-alpha", "Project Alpha"]));
    h.events.fail();
    assert.deepEqual([h.sync.state.status, h.sync.state.current], ["not_live", false]);
    assert.deepEqual(h.names(), ["p-alpha=Project Alpha"]);
    assert.equal(h.events.released, 1, "the failed subscription is released");
    assert.equal(h.sync.retry(), true);
    assert.equal(h.events.observers.size, 1, "subscribed again");
    await h.answer(1, list("g1", 0, ["p-alpha", "Project Alpha"]));
    assert.equal(h.sync.state.status, "ready");
  });

  it("a subscription that fails before the list, or cannot be made: one read, not live", async () => {
    for (const fails of ["error", "throws"] as const) {
      const h = setup(fails === "error" ? { activeOnSubscribe: false } : { observeThrows: true });
      h.sync.start(SERVER_ID);
      if (fails === "error") h.events.fail();
      await h.answer(0, list("g1", 0, ["p-gamma", "Project Gamma"]));
      assert.deepEqual([h.sync.state.status, h.names()], ["not_live", ["p-gamma=Project Gamma"]]);
      assert.ok(h.warnings.includes("project_subscription_failed"));
    }
  });
});

describe("ProjectDirectorySync: reconnect, host change and close", () => {
  it("a reconnect reads the list again; the older read's answer is dropped", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, list("g1", 0, ["p-alpha", "Project Alpha"]));
    h.events.reactivate();
    assert.deepEqual([h.sync.state.status, h.sync.state.current], ["refreshing", false]);
    await h.until(() => h.requests.length === 2);
    h.events.reactivate();
    await h.answerStale(1, list("g1", 0, ["p-alpha", "Old read"]));
    assert.equal(h.sync.state.status, "refreshing", "an older epoch's answer is not applied");
    await h.answer(2, list("g2", 0, ["p-alpha", "Project Alpha"], ["p-new", "New empty project"]));
    assert.deepEqual(h.names(), ["p-alpha=Project Alpha", "p-new=New empty project"]);
    assert.equal(h.sync.state.status, "ready");
  });

  it("a host change drops the old projects; a late answer for the old host is dropped", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.until(() => h.requests.length === 1);
    h.sync.hostChanged(OTHER_HOST);
    assert.deepEqual([h.sync.state.status, h.sync.state.projects.length], ["loading", 0]);
    await h.answerStale(0, list("g1", 0, ["p-old", "Old host project"]));
    assert.equal(h.sync.state.projects.length, 0);
    await h.answer(1, list("g9", 0, ["p-other", "Other host project"]));
    assert.deepEqual(h.names(), ["p-other=Other host project"]);
    assert.equal(h.sync.state.projects[0]?.address.serverId, OTHER_HOST);
  });

  it("a host change clears the loaded projects of the old host at once", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, list("g1", 0, ["p-alpha", "Project Alpha"]));
    assert.equal(h.sync.state.projects.length, 1);
    h.sync.hostChanged(OTHER_HOST);
    assert.deepEqual(
      [h.sync.state.status, h.sync.state.projects.length, h.sync.state.current],
      ["loading", 0, false],
    );
    await h.answer(1, list("g2", 0, ["p-other", "Other host project"]));
    assert.deepEqual(h.names(), ["p-other=Other host project"]);
  });

  it("close releases the subscription; late answers and updates change nothing", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.until(() => h.requests.length === 1);
    assert.equal(await h.sync.close(), true);
    assert.equal(h.events.released, 1);
    const changes = h.changes();
    h.requests[0]?.resolve(list("g1", 0, ["p-alpha", "Project Alpha"]));
    await h.requests[0]?.done;
    h.events.emit(upsert("p-alpha", "x", "g1", 1));
    assert.deepEqual([h.changes(), h.sync.state.projects.length], [changes, 0]);
    assert.equal(h.sync.retry(), false);
  });

  it("a failing release is reported as not released", async () => {
    const h = setup();
    h.events.releaseError = new Error("raw release");
    h.sync.start(SERVER_ID);
    assert.equal(await h.sync.close(), false);
    assert.equal(
      h.warnings.some((code) => code.includes("raw")),
      false,
    );
  });
});

describe("ProjectDirectorySync: cleanup of every subscription", () => {
  it("a failed subscription whose release rejects makes close report false", async () => {
    const h = setup();
    h.events.releaseError = new Error("raw release");
    h.sync.start(SERVER_ID);
    await h.answer(0, list("g1", 0, ["p-alpha", "Project Alpha"]));
    h.events.fail();
    assert.equal(h.sync.state.status, "not_live");
    assert.equal(await h.sync.close(), false);
    assert.ok(h.warnings.includes("project_release_failed"));
    assert.equal(JSON.stringify(h.warnings).includes("raw"), false);
  });

  it("close waits for a release still in progress and reports its failure", async () => {
    const h = setup();
    const gate = deferred<undefined>();
    h.events.releaseGate = gate.promise.then(() => undefined);
    h.events.releaseError = new Error("raw release");
    try {
      h.sync.start(SERVER_ID);
      await h.answer(0, list("g1", 0, ["p-alpha", "Project Alpha"]));
      h.events.fail();
      const closing = h.sync.close();
      // The release is held: close can only know its outcome after it.
      gate.resolve(undefined);
      assert.equal(await closing, false, "the held release's failure is reported");
    } finally {
      gate.resolve(undefined);
    }
  });

  it("an unsubscribe that throws makes close report false", async () => {
    const h = setup();
    h.events.unsubscribeError = new Error("raw unsubscribe");
    h.sync.start(SERVER_ID);
    await h.answer(0, list("g1", 0, ["p-alpha", "Project Alpha"]));
    assert.equal(await h.sync.close(), false);
    assert.equal(h.events.released, 1, "released anyway");
  });

  it("after Retry the old subscription's late callbacks change nothing; close waits for both releases", async () => {
    const h = setup();
    const gate = deferred<undefined>();
    try {
      h.sync.start(SERVER_ID);
      await h.answer(0, list("g1", 0, ["p-alpha", "Project Alpha"]));
      const old = [...h.events.observers][0];
      assert.ok(old);
      h.events.releaseGate = gate.promise.then(() => undefined);
      h.events.releaseError = new Error("raw release");
      h.events.fail();
      h.events.releaseError = null;
      assert.equal(h.sync.retry(), true);
      await h.answer(1, list("g1", 0, ["p-alpha", "Project Alpha"]));
      assert.equal(h.sync.state.status, "ready");
      const changes = h.changes();
      old.update({ type: "project.update", payload: upsert("p-alpha", "Late old", "g1", 9) });
      old.snapshot({ requestId: "late", subscriptionId: "old" });
      old.error?.(new Error("late"));
      assert.deepEqual(
        [h.changes(), h.names(), h.sync.state.status],
        [changes, ["p-alpha=Project Alpha"], "ready"],
      );
      const closing = h.sync.close();
      gate.resolve(undefined);
      assert.equal(await closing, false, "the first, failed release counts");
      assert.equal(h.events.released, 2);
    } finally {
      gate.resolve(undefined);
    }
  });

  it("repeated close calls share one finish and one outcome", async () => {
    const h = setup();
    h.events.releaseError = new Error("raw release");
    h.sync.start(SERVER_ID);
    const first = h.sync.close();
    const second = h.sync.close();
    assert.equal(second, first);
    assert.deepEqual([await first, await second, await h.sync.close()], [false, false, false]);
    assert.equal(h.events.released, 1, "released once");
  });
});

describe("ProjectDirectorySync: what the plugin cannot read is never current", () => {
  it("an unreadable project.update reads the list again; an unrelated event changes nothing", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, list("g1", 0, ["p-alpha", "Project Alpha"], ["p-beta", "Project Beta"]));
    const observer = [...h.events.observers][0];
    assert.ok(observer);
    observer.update({ type: "activity_log", payload: { anything: true } });
    assert.equal(h.sync.state.status, "ready", "not a project event");
    h.events.emit({ kind: "remove" });
    assert.deepEqual([h.sync.state.status, h.sync.state.current], ["refreshing", false]);
    assert.ok(h.warnings.includes("project_update_ignored"));
    await h.answer(1, list("g1", 3, ["p-alpha", "Project Alpha"]));
    assert.deepEqual([h.sync.state.status, h.names()], ["ready", ["p-alpha=Project Alpha"]]);
  });

  it("an unreadable update while the list is read means reading it again", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    h.events.emit({ kind: "upsert", project: { projectId: "" } });
    await h.answer(0, list("g1", 0, ["p-alpha", "Project Alpha"]));
    assert.equal(h.sync.state.status, "refreshing");
    await h.answer(1, list("g1", 1, ["p-alpha", "Project Alpha"]));
    assert.equal(h.sync.state.status, "ready");
  });

  it("a list with an invalid entry is never shown as the complete list; Retry reads again", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, {
      ...list("g1", 0, ["p-alpha", "Project Alpha"]),
      projects: [descriptor("p-alpha", "Project Alpha"), { projectId: "" }],
    });
    assert.deepEqual([h.sync.state.status, h.sync.state.current], ["unavailable", false]);
    assert.ok(h.warnings.includes("project_entry_skipped"));
    assert.ok(h.warnings.includes("project_list_invalid"));
    assert.equal(h.sync.retry(), true);
    await h.answer(1, list("g1", 0, ["p-alpha", "Project Alpha"]));
    assert.equal(h.sync.state.status, "ready");
  });
});

describe("ProjectDirectorySync: the list is always read with its sync position", () => {
  it("every read (start, re-read, Retry) asks with an empty sync cursor, so Paseo sends the position", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, list("g1", 0, ["p-alpha", "Project Alpha"]));
    h.events.emit(upsert("p-alpha", "Project Alpha", "g2", 1));
    await h.answer(1, list("g2", 1, ["p-alpha", "Project Alpha"]));
    h.events.fail();
    assert.equal(h.sync.retry(), true);
    await h.until(() => h.requests.length > 2);
    assert.deepEqual(
      h.requests.map((request) => request.options),
      [{ sync: {} }, { sync: {} }, { sync: {} }],
    );
  });

  it("a snapshot as Paseo 0.15.4 sends it (syncSeq per entry, reason no_cursor) is current", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, {
      requestId: "r",
      projects: [{ ...descriptor("p-alpha", "Project Alpha"), syncSeq: 1 }],
      sync: { generation: "g1", headSeq: 1, mode: "snapshot", reason: "no_cursor", removals: [] },
    });
    assert.deepEqual(
      [h.sync.state.status, h.sync.state.current, h.names()],
      ["ready", true, ["p-alpha=Project Alpha"]],
    );
  });

  it("a changes answer holds only part of the list and is never shown as the whole list", async () => {
    const h = setup();
    h.sync.start(SERVER_ID);
    await h.answer(0, {
      requestId: "r",
      projects: [descriptor("p-alpha", "Project Alpha")],
      sync: { generation: "g1", headSeq: 5, mode: "changes", removals: [{ id: "p-beta", seq: 4 }] },
    });
    assert.deepEqual([h.sync.state.status, h.sync.state.current], ["unavailable", false]);
    assert.ok(h.warnings.includes("project_list_invalid"));
  });
});
