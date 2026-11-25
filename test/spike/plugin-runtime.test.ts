import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createPluginRuntime, type PluginRuntime } from "../../src/spike/plugin-runtime.ts";
import { SETTINGS_READ_TIMEOUT_MS } from "../../src/connection/settings-reader.ts";
import type { LegacyFileRead } from "../../src/connection/connection-model.ts";
import { startInSettings } from "../../src/workspaces/start-in-settings.ts";
import { deferred, FakeClient, ManualScheduler } from "../support/fake-client.ts";
import { SERVER_ID } from "../support/fixtures.ts";
import { entry, snapshot, workspacePayload } from "../support/paseo-payloads.ts";
import { projectKey } from "../../src/workspaces/project-model.ts";

/**
 * The real runtime factory (M11b2c1) with all its real parts: feed
 * lifecycle, shutdown, navigation, keys, dials and their event
 * controllers. Its external effects are fakes the test counts: a manual
 * clock, a config the test answers, a client factory, an inspector, an
 * opener and exit. The first suite starts no feed; the second runs live
 * feeds (real FeedRecovery and AgentFeed over FakeClient) on the manual
 * clock through the test-only feedScheduler. The order of the eight
 * renderAll steps is not observed step by step: feed-projections.test.ts
 * (renderAllSteps) and source review cover it; the live suite shows each
 * dial and key drawing the results those steps produce. The SDK action
 * classes, their registration and the device are not exercised.
 */

const TARGET_FILE: LegacyFileRead = {
  kind: "text",
  text: JSON.stringify({ serverId: SERVER_ID, agentId: "agent-1" }),
};

/** One shared record of everything a runtime did outside itself. */
function harness() {
  const clock = new ManualScheduler();
  const effects: string[] = [];
  const settings = deferred<unknown>();
  const legacy = deferred<LegacyFileRead>();
  const runtime = createPluginRuntime({
    timers: clock,
    readLegacyFile: () => {
      effects.push("readLegacyFile");
      return legacy.promise;
    },
    getGlobalSettings: () => {
      effects.push("getGlobalSettings");
      return settings.promise;
    },
    setGlobalSettings: () => {
      effects.push("setGlobalSettings");
      return Promise.reject(new Error("no Save here"));
    },
    subscribeGlobalSettings: () => {
      effects.push("subscribeGlobalSettings");
      return {
        dispose: () => {
          effects.push("unsubscribeGlobalSettings");
        },
      };
    },
    createClient: () => {
      effects.push("createClient");
      return new FakeClient();
    },
    newChallenge: () => "challenge-00000001",
    sendConnectionMessage: (context) => {
      effects.push(`connection:${context}`);
      return Promise.resolve();
    },
    sendToInspector: (context, view) => {
      effects.push(`inspector:${context}:${view.selected}`);
      return Promise.resolve();
    },
    open: () => {
      effects.push("open");
      return Promise.resolve("requested");
    },
    now: () => 0,
    exit: () => effects.push("exit"),
    log: {
      info: (line) => effects.push(`info:${line}`),
      warn: (line) => effects.push(`warn:${line}`),
      error: (line) => effects.push(`error:${line}`),
    },
  });
  return { runtime, clock, effects, settings, legacy };
}

/**
 * A key or dial whose writes wait for the test. `accept()` resolves each
 * waiting write and waits for that same promise: the renderer awaited it
 * first, so its bookkeeping (and a queued write it then starts) is done
 * when the wait returns.
 */
class Gated {
  readonly id: string;
  readonly deviceId = "dev";
  readonly coordinates = { column: 0, row: 0 };
  readonly writes: string[] = [];
  alerts = 0;
  private readonly pending: { done: Promise<void>; resolve: () => void }[] = [];
  constructor(id: string) {
    this.id = id;
  }
  private write(entry: string): Promise<void> {
    this.writes.push(entry);
    let resolve: () => void = () => undefined;
    const done = new Promise<void>((accept) => {
      resolve = accept;
    });
    this.pending.push({ done, resolve });
    return done;
  }
  readonly setImage = (): Promise<void> => this.write("image");
  readonly setTitle = (): Promise<void> => Promise.resolve();
  readonly setFeedback = (payload: { readonly value: unknown }): Promise<void> =>
    this.write(`feedback:${JSON.stringify(payload.value)}`);
  readonly setSettings = (): Promise<void> => Promise.resolve();
  readonly showAlert = (): Promise<void> => {
    this.alerts += 1;
    return Promise.resolve();
  };
  readonly showOk = (): Promise<void> => Promise.resolve();
  async accept(): Promise<void> {
    for (let next = this.pending.shift(); next !== undefined; next = this.pending.shift()) {
      next.resolve();
      await next.done;
    }
  }
  get waiting(): number {
    return this.pending.length;
  }
}

/** One of every key and dial, all with the same IDs on the same device. */
function showAll(runtime: PluginRuntime, workspaceSettings: unknown = {}) {
  const slot = new Gated("slot");
  const pages = new Gated("pages");
  const workspace = new Gated("workspace");
  const usage = new Gated("usage");
  const attention = new Gated("attention");
  runtime.keys.slotAppeared(slot);
  runtime.pages.appeared(pages);
  runtime.workspace.appeared(workspace, workspaceSettings);
  runtime.usage.appeared(usage);
  runtime.attention.appeared(attention);
  const all = [slot, pages, workspace, usage, attention];
  return {
    all,
    /**
     * Accepts every waiting write. For the agent key this proves its image
     * write was accepted, not that its two-step draw finished.
     */
    acceptAll: async () => {
      for (const gated of all) await gated.accept();
    },
  };
}

// Never needed to pass: a broken runtime can leave a write or a config no
// test answers, and this turns that endless wait into a failure.
const HANG_LIMIT = { timeout: 10_000 };

describe("createPluginRuntime without a feed", HANG_LIMIT, () => {
  it("creating a runtime has no external effect", () => {
    const { clock, effects } = harness();
    assert.deepEqual(effects, [], "no config read, client, inspector, open, exit or log");
    assert.equal(clock.pendingTimers, 0, "no timer");
  });

  it("two runtimes keep their own keys, dials, Start in and shutdown (no feed)", async () => {
    const first = harness();
    const second = harness();
    // A saved Start in the second's twin dial does not have.
    const shown = showAll(
      first.runtime,
      startInSettings({ serverId: SERVER_ID, projectId: "project-1" }),
    );
    await shown.acceptAll();
    assert.ok(
      shown.all.every((gated) => gated.writes.length > 0),
      "every key and dial of the first was drawn",
    );
    assert.equal(second.effects.length, 0, "nothing reached the second");
    assert.equal(second.clock.pendingTimers, 0, "no Usage redraw timer in the second");

    // The same IDs on the same device are unknown to the second runtime.
    const probe = new Gated("pages");
    await second.runtime.pages.rotated(probe, 1);
    await second.runtime.pages.pressed(probe);
    assert.equal(second.effects.length, 0, "no redraw or log there");
    await second.runtime.keys.slotPressed(new Gated("slot"));
    // As for any key the runtime does not know: refused, nothing opened.
    assert.deepEqual(second.effects, ["info:press refused: identity_changing"]);
    assert.equal(probe.alerts, 0);

    // A source error, so no feed starts in this suite (it has no feed clock).
    const run = second.runtime.start();
    second.settings.resolve({});
    second.legacy.resolve({ kind: "unreadable" });
    await run;
    assert.ok(second.effects.includes("info:connection blocked: legacy_unreadable"));
    assert.equal(
      first.effects.some(
        (effect) => effect.endsWith("GlobalSettings") || effect === "readLegacyFile",
      ),
      false,
      "the first read neither settings nor file",
    );

    // The same IDs on the same device in both: shutting the second down
    // leaves the first's keys and dials known and drawn.
    const twins = showAll(second.runtime);
    await twins.acceptAll();
    await second.runtime.shutdown();
    const mark = first.effects.length;
    const [, pages] = shown.all;
    assert.ok(pages);
    await first.runtime.pages.pressed(pages);
    await first.runtime.workspace.inspectorShown("workspace");
    assert.deepEqual(first.effects.slice(mark), [
      "info:pages dial: press_not_current",
      "info:workspace dial: inspector_shown",
      "inspector:workspace:saved",
    ]);
    assert.equal(pages.alerts, 1);
    await pages.accept();
    assert.deepEqual(
      [first.effects.includes("exit"), second.effects.includes("exit")],
      [false, true],
    );
    const late = new Gated("usage-2");
    first.runtime.usage.appeared(late);
    assert.equal(late.writes.length, 1, "the first still shows new dials");
    await late.accept();
    await first.runtime.shutdown();
  });

  it("shutdown stops every key and dial timer, then exits; later events draw nothing", async () => {
    const { runtime, clock, effects } = harness();
    const shown = showAll(runtime);
    await shown.acceptAll();
    assert.ok(clock.pendingTimers > 0, "the Usage dial's countdown redraw is scheduled");
    await runtime.shutdown();
    assert.equal(clock.pendingTimers, 0, "no scroller, countdown or grace timer is left");
    assert.deepEqual(effects.slice(-2), ["info:shutdown: clean", "exit"]);

    const after = new Gated("late");
    runtime.keys.slotAppeared(after);
    runtime.pages.appeared(after);
    runtime.workspace.appeared(after, {});
    runtime.usage.appeared(after);
    runtime.attention.appeared(after);
    assert.deepEqual(after.writes, [], "nothing appears during shutdown");

    // The controllers no longer know the shown keys and dials: keys and the
    // Usage and Workspace turns refuse as for unknown ones, Pages and
    // Attention do nothing, and no inspector is sent a view.
    const mark = effects.length;
    const [slot, pages, workspace, usage, attention] = shown.all;
    assert.ok(slot && pages && workspace && usage && attention);
    await runtime.keys.slotPressed(slot);
    await runtime.pages.rotated(pages, 1);
    await runtime.pages.pressed(pages);
    await runtime.workspace.inspectorShown("workspace");
    await runtime.workspace.rotated(workspace, 1);
    await runtime.usage.rotated(usage, 1);
    await runtime.attention.pressed(attention);
    assert.deepEqual(effects.slice(mark), [
      "info:press refused: identity_changing",
      "info:workspace dial: rotate_not_current",
    ]);
    assert.deepEqual(
      shown.all.map((gated) => gated.alerts),
      [1, 0, 1, 1, 0],
    );
    assert.ok(
      shown.all.every((gated) => gated.waiting === 0),
      "the visible keys and dials are sent nothing more",
    );
    await runtime.shutdown();
    assert.equal(effects.filter((effect) => effect === "exit").length, 1, "one shutdown");
  });

  it("sources that answer after shutdown began start no feed and draw nothing", async () => {
    const { runtime, effects, settings, legacy } = harness();
    const shown = showAll(runtime);
    await shown.acceptAll();
    const start = runtime.start();
    assert.deepEqual(effects.slice(-3), [
      "subscribeGlobalSettings",
      "getGlobalSettings",
      "readLegacyFile",
    ]);
    await runtime.shutdown();
    assert.ok(
      effects.indexOf("unsubscribeGlobalSettings") < effects.indexOf("exit"),
      "the settings subscription is disposed before exit",
    );
    settings.resolve({});
    legacy.resolve(TARGET_FILE);
    await start;
    assert.equal(effects.includes("createClient"), false, "no client, no feed");
    assert.equal(
      effects.some((effect) => effect.startsWith("info:connection")),
      false,
      "no source is chosen after shutdown",
    );
    assert.ok(
      shown.all.every((gated) => gated.waiting === 0),
      "its redraw reaches no disposed key or dial",
    );
  });
});

/** One host's synthetic data for a live runtime. */
interface Host {
  readonly serverId: string;
  readonly agentId: string;
  readonly title: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly usageLabel: string;
}

const HOST_A: Host = {
  serverId: SERVER_ID,
  agentId: "agent-alpha",
  title: "Alpha agent with a long title that keeps scrolling on the key",
  workspaceId: "ws-alpha",
  workspaceName: "alpha-main",
  projectId: "p-alpha",
  projectName: "Project Alpha",
  usageLabel: "AlphaWindow",
};
const HOST_B: Host = {
  serverId: "srv_OtherHost02",
  agentId: "agent-beta",
  title: "Beta",
  workspaceId: "ws-beta",
  workspaceName: "beta-main",
  projectId: "p-beta",
  projectName: "Project Beta",
  usageLabel: "BetaWindow",
};

/** A client whose close is recorded among the runtime's effects. */
class RecordedClient extends FakeClient {
  private readonly effects: string[];
  constructor(effects: string[]) {
    super();
    this.effects = effects;
  }
  override close(): Promise<void> {
    this.effects.push("close");
    return super.close();
  }
}

const usagePayload = (host: Host) => ({
  providers: [
    {
      providerId: "claude",
      displayName: "Claude",
      status: "available",
      windows: [{ id: "w", label: host.usageLabel, usedPct: 40 }],
    },
  ],
});

const agentEntry = (host: Host, title = host.title) =>
  entry({
    id: host.agentId,
    title,
    status: "running",
    workspaceId: host.workspaceId,
    pendingPermissions: [{ id: "p1", kind: "question", name: "Ask" }],
  });

/** A live agent change: the same agent with a new title. */
const renamed = (host: Host, title: string, updatedAt = "2026-11-14T11:00:00.000Z") => {
  const changed = entry({
    id: host.agentId,
    title,
    status: "running",
    workspaceId: host.workspaceId,
    pendingPermissions: [{ id: "p1", kind: "question", name: "Ask" }],
    // A newer update; an equal timestamp is not applied as a change.
    updatedAt,
  });
  return { kind: "upsert", agent: changed["agent"], project: changed["project"] };
};

/** A runtime over one host's live feed; one manual clock drives everything. */
/** The legacy file as the E1 target of `host` (no address: the default). */
const targetFileOf = (host: Host): LegacyFileRead => ({
  kind: "text",
  text: JSON.stringify({ serverId: host.serverId, agentId: host.agentId }),
});

function live(
  host: Host,
  legacyFile: LegacyFileRead = targetFileOf(host),
  /** The global settings read; answered at once with nothing saved by default. */
  getGlobalSettings: () => Promise<unknown> = () => Promise.resolve({}),
) {
  const clock = new ManualScheduler();
  const effects: string[] = [];
  const opened: string[] = [];
  const started = deferred<undefined>();
  const usage = deferred<unknown>();
  const client = new RecordedClient(effects);
  client.serverId = host.serverId;
  client.initialSnapshot = snapshot([agentEntry(host)]);
  client.workspaces.initialSnapshot = snapshot([
    workspacePayload({ id: host.workspaceId, name: host.workspaceName, projectId: host.projectId }),
  ]);
  // The host's project list (P1), read by the feed after its first snapshots.
  client.listedProjects = [
    {
      projectId: host.projectId,
      projectDisplayName: host.projectName,
      projectRootPath: "/tmp/synthetic",
      projectKind: "git",
    },
  ];
  client.usageAnswers.push(usage.promise);
  const record = (line: string) => {
    effects.push(line);
    if (line === "feed started") started.resolve(undefined);
  };
  const runtime = createPluginRuntime({
    timers: clock,
    feedScheduler: clock,
    // Nothing saved; the legacy file gives the E1 target and implies the default address.
    getGlobalSettings,
    subscribeGlobalSettings: () => ({ dispose: () => undefined }),
    setGlobalSettings: () => {
      effects.push("setGlobalSettings");
      return Promise.reject(new Error("no Save here"));
    },
    readLegacyFile: () => Promise.resolve(legacyFile),
    createClient: () => {
      effects.push("createClient");
      return client;
    },
    newChallenge: () => "challenge-00000001",
    sendConnectionMessage: (context) => {
      effects.push(`connection:${context}`);
      return Promise.resolve();
    },
    sendToInspector: (context, view) => {
      effects.push(`inspector:${context}:${view.selected}`);
      return Promise.resolve();
    },
    open: (address) => {
      effects.push("open");
      opened.push(`${address.serverId}:${address.agentId}`);
      return Promise.resolve("requested");
    },
    now: () => 0,
    exit: () => effects.push("exit"),
    log: { info: record, warn: record, error: record },
  });
  return { runtime, clock, effects, opened, client, started: started.promise, usage };
}

/** A key that accepts every write at once and keeps the drawn text. */
class LiveKey {
  readonly id: string;
  readonly deviceId = "dev";
  readonly coordinates = { column: 0, row: 0 };
  readonly images: string[] = [];
  alerts = 0;
  private readonly watchers: { text: string; seen: () => void }[] = [];
  constructor(id: string) {
    this.id = id;
  }
  readonly setImage = (image: string): Promise<void> => {
    const decoded = decodeURIComponent(image);
    this.images.push(decoded);
    for (const watcher of this.watchers) if (decoded.includes(watcher.text)) watcher.seen();
    return Promise.resolve();
  };
  /**
   * Settles once a draw showing `text` started (its image was written). It
   * does not mean the two-step draw finished.
   */
  drawing(text: string, from = 0): Promise<void> {
    const seen = deferred<undefined>();
    if (this.images.slice(from).some((image) => image.includes(text))) seen.resolve(undefined);
    else
      this.watchers.push({
        text,
        seen: () => {
          seen.resolve(undefined);
        },
      });
    return seen.promise;
  }
  readonly setTitle = (): Promise<void> => Promise.resolve();
  readonly showAlert = (): Promise<void> => {
    this.alerts += 1;
    return Promise.resolve();
  };
  readonly showOk = (): Promise<void> => Promise.resolve();
}

/**
 * An agent key whose title write (the last step of a draw) waits for the
 * test. settle() accepts each waiting title and waits for that same
 * promise: the renderer awaited it first, so the draw is recorded as shown
 * when settle() returns, and a press acts on it. Since the E1 key was
 * removed, this is the explicit signal for a finished agent key draw.
 */
class SettledKey extends LiveKey {
  private readonly titles: { done: Promise<void>; resolve: () => void }[] = [];
  override readonly setTitle = (): Promise<void> => {
    let resolve: () => void = () => undefined;
    const done = new Promise<void>((accept) => {
      resolve = accept;
    });
    this.titles.push({ done, resolve });
    return done;
  };
  async settle(): Promise<void> {
    for (let next = this.titles.shift(); next !== undefined; next = this.titles.shift()) {
      next.resolve();
      await next.done;
    }
  }
}

/** A new agent key on slot 0 whose draw of `text` finished; a press acts on it. */
async function drawnAgentKey(runtime: PluginRuntime, id: string, text: string) {
  const key = new SettledKey(id);
  runtime.keys.slotAppeared(key);
  await key.drawing(text);
  await key.settle();
  return key;
}

/** A dial strip whose writes wait for the test; it can wait for a write. */
class LiveStrip {
  readonly id: string;
  readonly deviceId = "dev";
  readonly writes: string[] = [];
  alerts = 0;
  private readonly pending: { done: Promise<void>; resolve: () => void }[] = [];
  private readonly watchers: { match: (write: string) => boolean; seen: () => void }[] = [];
  constructor(id: string) {
    this.id = id;
  }
  readonly setFeedback = (payload: unknown): Promise<void> => {
    const write = JSON.stringify(payload);
    this.writes.push(write);
    for (const watcher of this.watchers) if (watcher.match(write)) watcher.seen();
    let resolve: () => void = () => undefined;
    const done = new Promise<void>((accept) => {
      resolve = accept;
    });
    this.pending.push({ done, resolve });
    return done;
  };
  /** Every payload handed to setSettings (the action settings write), in order. */
  readonly settings: unknown[] = [];
  readonly setSettings = (settings: unknown): Promise<void> => {
    this.settings.push(settings);
    return Promise.resolve();
  };
  readonly showAlert = (): Promise<void> => {
    this.alerts += 1;
    return Promise.resolve();
  };
  /** Accepts every waiting write, waiting for each same promise (one-step sender). */
  async accept(): Promise<void> {
    for (let next = this.pending.shift(); next !== undefined; next = this.pending.shift()) {
      next.resolve();
      await next.done;
    }
  }
  /** Settles once a write containing `text` was issued (or already was). */
  written(text: string): Promise<void> {
    const seen = deferred<undefined>();
    if (this.writes.some((write) => write.includes(text))) seen.resolve(undefined);
    else
      this.watchers.push({
        match: (write) => write.includes(text),
        seen: () => {
          seen.resolve(undefined);
        },
      });
    return seen.promise;
  }
  get waiting(): number {
    return this.pending.length;
  }
}

/** Every key and dial of a live runtime, with the same IDs in each runtime. */
function showLive(
  runtime: PluginRuntime,
  host: Host,
  /** By default a version 1 Start in (the host's workspace), resolved to its project (P2). */
  startIn: unknown = {
    version: 1,
    startIn: { serverId: host.serverId, workspaceId: host.workspaceId },
  },
) {
  const slot = new LiveKey("slot");
  const pages = new LiveStrip("pages");
  const workspace = new LiveStrip("workspace");
  const usage = new LiveStrip("usage");
  const attention = new LiveStrip("attention");
  runtime.keys.slotAppeared(slot);
  runtime.pages.appeared(pages);
  runtime.workspace.appeared(workspace, startIn);
  runtime.usage.appeared(usage);
  runtime.attention.appeared(attention);
  const strips = [pages, workspace, usage, attention];
  return {
    slot,
    pages,
    workspace,
    usage,
    attention,
    strips,
    acceptStrips: async () => {
      for (const strip of strips) await strip.accept();
    },
  };
}

/** Starts the runtime's live feed and accepts the strips it drew. */
async function startLive(
  harnessed: ReturnType<typeof live>,
  shown: Awaited<ReturnType<typeof showLive>>,
) {
  await shown.acceptStrips();
  await harnessed.runtime.start();
  await harnessed.started;
  await shown.acceptStrips();
}

describe("createPluginRuntime with live feeds", HANG_LIMIT, () => {
  it("unreadable settings: a press on the drawn Retry reads again without a second request, then one feed", async () => {
    // A settled agent key: the press acts on an accepted "Retry" view.
    const settings = deferred<unknown>();
    let reads = 0;
    const a = live(HOST_A, targetFileOf(HOST_A), () => {
      reads += 1;
      return settings.promise;
    });
    const shown = showLive(a.runtime, HOST_A);
    await shown.acceptStrips();
    await a.runtime.start();
    assert.equal(reads, 1);

    a.clock.advance(SETTINGS_READ_TIMEOUT_MS);
    const key = await drawnAgentKey(a.runtime, "retry-key", ">Retry<");
    assert.ok(key.images.at(-1)?.includes(">Retry<"), "the key shows Paseo settings Retry");
    await shown.acceptStrips();

    await a.runtime.keys.slotPressed(key);
    assert.equal(reads, 1, "the read in flight is reused, no second SDK request");
    assert.deepEqual(a.opened, [], "a press on Retry opens no agent");
    assert.equal(key.alerts, 0, "the retry was accepted");
    assert.ok(key.images.at(-1)?.includes(">Loading<"), "reading again: loading");
    await key.settle();
    assert.equal(a.effects.filter((effect) => effect === "createClient").length, 0);

    settings.resolve({});
    await settings.promise;
    await a.started;
    await shown.acceptStrips();
    assert.equal(
      a.effects.filter((effect) => effect === "createClient").length,
      1,
      "exactly one client",
    );
    await shown.slot.drawing(">Alpha<");
    const usageShown = shown.usage.written(HOST_A.usageLabel);
    a.usage.resolve(usagePayload(HOST_A));
    await usageShown;
    await shown.acceptStrips();
    await key.settle();
    await a.runtime.shutdown();
  });

  it("a legacy file whose E1 target is missing, incomplete or of another host still connects", async () => {
    // The E1 key action was removed (2026-11-25); the legacy file still gives
    // the address, and its target never blocks the agent keys or dials.
    const cases: LegacyFileRead[] = [
      { kind: "missing" },
      // An explicit valid address with an incomplete target: the address
      // still connects (a file with neither would block, plan 4.2).
      {
        kind: "text",
        text: JSON.stringify({ serverId: HOST_A.serverId, daemonUrl: "ws://127.0.0.1:6767/ws" }),
      },
      targetFileOf({ ...HOST_A, serverId: "srv_OtherHost02" }),
    ];
    for (const legacyFile of cases) {
      const a = live(HOST_A, legacyFile);
      const shown = showLive(a.runtime, HOST_A);
      await startLive(a, shown);
      // The connection is valid: the slot key and all four dials show the feed.
      await shown.slot.drawing(">Alpha<");
      assert.ok(shown.pages.writes.at(-1)?.includes("Page 1 / 1"));
      assert.ok(shown.workspace.writes.at(-1)?.includes(HOST_A.projectName));
      assert.ok(shown.attention.writes.at(-1)?.includes("Alpha agent"));
      const usageShown = shown.usage.written(HOST_A.usageLabel);
      a.usage.resolve(usagePayload(HOST_A));
      await usageShown;
      assert.deepEqual(a.opened, [], "nothing is opened by itself");
      await shown.acceptStrips();
      await a.runtime.shutdown();
    }
  });

  it("each runtime draws its own host's data from one full render after its feed is ready", async () => {
    const a = live(HOST_A);
    const shown = showLive(a.runtime, HOST_A);
    await startLive(a, shown);

    // Navigation.sync placed the confirmed workspace's agent before the keys
    // and strips were drawn from it.
    await shown.slot.drawing(">Alpha<"); // the slot key draws the placed agent
    assert.ok(shown.pages.writes.at(-1)?.includes("Page 1 / 1"), "Pages: the synced layout");
    // The Project dial (P2): Start in names a workspace (version 1), shown as its project.
    assert.ok(shown.workspace.writes.at(-1)?.includes(HOST_A.projectName), "Project: resolved");
    assert.ok(shown.attention.writes.at(-1)?.includes("Alpha agent"), "Attention: the real agent");

    // syncUsage asked once for the visible Usage dial; its answer redraws the
    // Usage dial through the poller's own onChange, not a full render.
    assert.equal(a.client.usageCalls, 1);
    const usageShown = shown.usage.written(HOST_A.usageLabel);
    a.usage.resolve(usagePayload(HOST_A));
    await usageShown;
    await shown.acceptStrips();

    await a.runtime.shutdown();
  });

  it("a live project rename redraws the Project dial; the inspector's Retry reads the feed's project list again", async () => {
    const a = live(HOST_A);
    const shown = showLive(a.runtime, HOST_A);
    await startLive(a, shown);
    await shown.workspace.written(HOST_A.projectName);

    // Only a project.update arrives: onProjectsChange alone must redraw (P2).
    const renamed = shown.workspace.written("Project Alpha renamed");
    a.client.projectEvents.emit({
      kind: "upsert",
      project: {
        projectId: HOST_A.projectId,
        projectDisplayName: "Project Alpha renamed",
        projectRootPath: "/tmp/synthetic",
        projectKind: "git",
      },
      generation: "g1",
      // After the snapshot (headSeq 1, one project), as the daemon sequences it.
      seq: 2,
    });
    await renamed;
    await shown.acceptStrips();

    // The subscription fails: the strip says so, and the inspector's Retry
    // reaches the real feed's retryProjects (a new list read).
    const notLive = shown.workspace.written("Projects not live");
    a.client.projectEvents.fail();
    await notLive;
    await shown.acceptStrips();
    const reads = a.client.projectListCalls;
    await a.runtime.workspace.inspectorMessage("workspace", { type: "retry_projects" });
    assert.equal(a.client.projectListCalls, reads + 1, "the project list is read again");
    assert.ok(a.effects.includes("workspace dial: projects_retry_started"));
    await shown.acceptStrips();
    const usageShown = shown.usage.written(HOST_A.usageLabel);
    a.usage.resolve(usagePayload(HOST_A));
    await usageShown;
    await shown.acceptStrips();
    await a.runtime.shutdown();
  });

  it("two live runtimes with the same IDs keep their feed, selection, keys, usage and shutdown apart", async () => {
    const a = live(HOST_A);
    const b = live(HOST_B);
    const shownA = showLive(a.runtime, HOST_A);
    const shownB = showLive(b.runtime, HOST_B);
    await startLive(a, shownA);
    await startLive(b, shownB);
    const usageA = shownA.usage.written(HOST_A.usageLabel);
    const usageB = shownB.usage.written(HOST_B.usageLabel);
    a.usage.resolve(usagePayload(HOST_A));
    b.usage.resolve(usagePayload(HOST_B));
    await usageA;
    await usageB;
    await shownA.acceptStrips();
    await shownB.acceptStrips();

    assert.deepEqual(
      [
        a.effects.filter((e) => e === "createClient").length,
        b.effects.filter((e) => e === "createClient").length,
      ],
      [1, 1],
      "one client each",
    );
    await shownA.slot.drawing(">Alpha<");
    await shownB.slot.drawing(">Beta<");
    assert.ok(!shownA.slot.images.some((image) => image.includes(">Beta<")), "never the other's");
    assert.ok(!shownB.slot.images.some((image) => image.includes(">Alpha<")));
    assert.ok(!shownA.usage.writes.some((write) => write.includes(HOST_B.usageLabel)));
    assert.ok(!shownB.usage.writes.some((write) => write.includes(HOST_A.usageLabel)));
    await a.runtime.workspace.inspectorShown("workspace");
    await b.runtime.workspace.inspectorShown("workspace");
    assert.equal(
      a.effects.at(-1),
      `inspector:workspace:${projectKey({ serverId: HOST_A.serverId, projectId: HOST_A.projectId })}`,
    );
    assert.equal(
      b.effects.at(-1),
      `inspector:workspace:${projectKey({ serverId: HOST_B.serverId, projectId: HOST_B.projectId })}`,
    );

    // A settled agent key in each runtime: a finished draw of its own agent.
    const keyA = await drawnAgentKey(a.runtime, "agent-key", ">Alpha<");
    const keyB = await drawnAgentKey(b.runtime, "agent-key", ">Beta<");
    await a.runtime.keys.slotPressed(keyA);
    await b.runtime.keys.slotPressed(keyB);
    assert.deepEqual(a.opened, [`${HOST_A.serverId}:${HOST_A.agentId}`], "each its own agent");
    assert.deepEqual(b.opened, [`${HOST_B.serverId}:${HOST_B.agentId}`]);

    await a.runtime.shutdown();
    assert.deepEqual([a.client.closed, b.client.closed], [1, 0], "only the first's client");
    assert.deepEqual([a.clock.pendingTimers, a.clock.active], [0, 0], "the first's clock is idle");
    assert.ok(b.clock.active > 0, "the second still polls its link");

    // The second still follows its feed and opens its agent.
    b.client.emitUpdate(renamed(HOST_B, "Gamma"));
    await shownB.slot.drawing(">Gamma<");
    await keyB.drawing(">Gamma<");
    await keyB.settle();
    await b.runtime.keys.slotPressed(keyB);
    assert.deepEqual(b.opened.length, 2, "the second opens its agent again");
    assert.equal(b.opened.at(-1), `${HOST_B.serverId}:${HOST_B.agentId}`);
    await shownB.acceptStrips();
    await keyB.settle();
    await b.runtime.shutdown();
  });

  it("shutdown with a live feed, poller and scroller closes the client before exit; late events draw nothing", async () => {
    const a = live(HOST_A);
    const shown = showLive(a.runtime, HOST_A);
    await startLive(a, shown);
    assert.equal(a.client.usageCalls, 1, "a usage request is in flight");
    assert.ok(a.clock.pendingTimers > 0, "the long title scrolls, the Usage countdown waits");
    assert.ok(a.clock.active > 0, "the feed polls its link");

    // A render whose strip writes are still waiting when shutdown begins.
    a.client.emitUpdate(renamed(HOST_A, "Delta"));
    await shown.attention.written("Delta");
    assert.ok(shown.attention.waiting > 0, "the Attention write is still in flight");

    await a.runtime.shutdown();
    const exitAt = a.effects.indexOf("exit");
    assert.ok(
      a.effects.includes("close") && a.effects.indexOf("close") < exitAt,
      "closed, then exit",
    );
    assert.deepEqual(
      [a.clock.pendingTimers, a.clock.active],
      [0, 0],
      "no scroller, countdown, poller or link timer",
    );

    const keyImages = shown.slot.images.length;
    const stripWrites = shown.strips.map((strip) => strip.writes.length);
    a.client.emitUpdate(renamed(HOST_A, "Epsilon", "2026-11-14T12:00:00.000Z"));
    a.usage.resolve(usagePayload(HOST_A));
    await a.usage.promise;
    await shown.acceptStrips();
    assert.equal(shown.slot.images.length, keyImages, "no key draw");
    assert.deepEqual(
      shown.strips.map((strip) => strip.writes.length),
      stripWrites,
      "accepting the earlier writes sends nothing new",
    );
    assert.deepEqual([a.clock.pendingTimers, a.clock.active], [0, 0], "and starts no timer");
  });
});

const ADDRESS_A = "ws://localhost:7801/ws";
const ADDRESS_B = "ws://localhost:7802/ws";
const savedAddress = (daemonUrl: string) => ({ connection: { version: 1, daemonUrl } });

/**
 * A live runtime whose saved address changes from the outside (C3b2): one
 * client per created feed, its host chosen by the address, and the settings
 * listener captured so the test can deliver an outside change.
 */
function switchable(legacyFile: LegacyFileRead) {
  const clock = new ManualScheduler();
  const effects: string[] = [];
  const opened: string[] = [];
  const clients: { url: string; client: RecordedClient; usage: ReturnType<typeof deferred> }[] = [];
  const feedsStarted: (() => void)[] = [];
  let startedCount = 0;
  let listener: ((settings: unknown) => void) | null = null;
  const record = (line: string) => {
    effects.push(line);
    if (line !== "feed started") return;
    startedCount += 1;
    for (const resolve of feedsStarted.splice(0)) resolve();
  };
  const runtime = createPluginRuntime({
    timers: clock,
    feedScheduler: clock,
    getGlobalSettings: () => Promise.resolve(savedAddress(ADDRESS_A)),
    setGlobalSettings: () => {
      effects.push("setGlobalSettings");
      return Promise.reject(new Error("no Save here"));
    },
    subscribeGlobalSettings: (next) => {
      listener = next;
      return {
        dispose: () => {
          listener = null;
        },
      };
    },
    readLegacyFile: () => Promise.resolve(legacyFile),
    createClient: (url) => {
      effects.push("createClient");
      const host = url === ADDRESS_A ? HOST_A : HOST_B;
      const client = new RecordedClient(effects);
      client.serverId = host.serverId;
      client.initialSnapshot = snapshot([agentEntry(host)]);
      client.workspaces.initialSnapshot = snapshot([
        workspacePayload({ id: host.workspaceId, name: host.workspaceName }),
      ]);
      const usage = deferred<unknown>();
      client.usageAnswers.push(usage.promise);
      clients.push({ url, client, usage });
      return client;
    },
    newChallenge: () => "challenge-00000001",
    sendConnectionMessage: (context) => {
      effects.push(`connection:${context}`);
      return Promise.resolve();
    },
    sendToInspector: () => Promise.resolve(),
    open: (address) => {
      effects.push("open");
      opened.push(`${address.serverId}:${address.agentId}`);
      return Promise.resolve("requested");
    },
    now: () => 0,
    exit: () => effects.push("exit"),
    log: { info: record, warn: record, error: record },
  });
  return {
    runtime,
    effects,
    opened,
    clients,
    /** An outside settings change, delivered synchronously as the SDK does. */
    emitOutside: (settings: unknown) => {
      listener?.(settings);
    },
    /** Settles once `count` feeds have started. */
    feedsStarted: (count: number): Promise<void> => {
      if (startedCount >= count) return Promise.resolve();
      const seen = deferred<undefined>();
      feedsStarted.push(() => {
        if (startedCount >= count) seen.resolve(undefined);
      });
      return seen.promise.then(() => undefined);
    },
  };
}

/** Holds the client's close until the returned function is called. */
function holdClose(client: FakeClient): () => void {
  const gate = deferred<undefined>();
  client.closeGate = gate.promise.then(() => undefined);
  return () => {
    gate.resolve(undefined);
  };
}

describe("createPluginRuntime: an address change from the settings (C3b2)", HANG_LIMIT, () => {
  it("the old agent is gone and its press refused while switching; then the new host's agent is shown and opened", async () => {
    // The E1 target is host B's agent: of another host until the switch.
    const h = switchable(targetFileOf(HOST_B));
    // Start in All: after the switch a saved project of host A would stay
    // unresolved on host B (P2); this suite is about the connection switch.
    const shown = showLive(h.runtime, HOST_A, {});
    await shown.acceptStrips();
    await h.runtime.start();
    await h.feedsStarted(1);
    await shown.acceptStrips();
    await shown.slot.drawing(">Alpha<");
    const [first] = h.clients;
    assert.ok(first);
    assert.equal(first.client.usageCalls, 1, "the old instance's Usage request is in flight");

    const release = holdClose(first.client);
    const keyMark = shown.slot.images.length;
    const usageMark = shown.usage.writes.length;
    h.emitOutside(savedAddress(ADDRESS_B));
    await shown.slot.drawing(">Loading<", keyMark);
    await shown.acceptStrips();
    assert.ok(h.effects.includes("connection switch: closing"));

    // The old agent is no longer on the key: its press opens nothing.
    await h.runtime.keys.slotPressed(shown.slot);
    assert.deepEqual(h.opened, [], "no press reaches the old agent");
    assert.equal(shown.slot.alerts, 1);
    // The old instance's Usage answer arrives during the switch.
    first.usage.resolve(usagePayload(HOST_A));
    await first.usage.promise;

    release();
    await h.feedsStarted(2);
    await shown.acceptStrips();
    assert.deepEqual(
      h.clients.map((entry) => entry.url),
      [ADDRESS_A, ADDRESS_B],
    );
    assert.ok(
      h.effects.indexOf("close") < h.effects.lastIndexOf("createClient"),
      "the old client was closed before the new one was created",
    );
    await shown.slot.drawing(">Beta<", keyMark);
    const [, second] = h.clients;
    assert.ok(second);
    const usageShown = shown.usage.written(HOST_B.usageLabel);
    second.usage.resolve(usagePayload(HOST_B));
    await usageShown;
    await shown.acceptStrips();
    assert.equal(
      shown.usage.writes.slice(usageMark).some((write) => write.includes(HOST_A.usageLabel)),
      false,
      "the old instance's Usage answer was dropped",
    );

    // An agent key now shows and opens the new host's agent.
    const key = await drawnAgentKey(h.runtime, "switch-key", ">Beta<");
    await h.runtime.keys.slotPressed(key);
    assert.deepEqual(h.opened, [`${HOST_B.serverId}:${HOST_B.agentId}`]);
    await shown.acceptStrips();
    await key.settle();
    await h.runtime.shutdown();
    assert.equal(second.client.closed, 1);
  });

  it("an unconfirmed close shows Restart the plugin; a press retries nothing and no new client starts", async () => {
    const h = switchable(targetFileOf(HOST_A));
    // Start in All: after the switch a saved project of host A would stay
    // unresolved on host B (P2); this suite is about the connection switch.
    const shown = showLive(h.runtime, HOST_A, {});
    await shown.acceptStrips();
    await h.runtime.start();
    await h.feedsStarted(1);
    await shown.acceptStrips();
    const [first] = h.clients;
    assert.ok(first);
    first.client.closeError = new Error("raw close");
    first.usage.resolve(usagePayload(HOST_A));
    h.emitOutside(savedAddress(ADDRESS_B));
    await shown.slot.drawing(">Restart<");
    assert.ok(h.effects.includes("connection switch blocked: failed"));
    // A settled agent key: a finished draw of the blocked view before the press.
    const key = await drawnAgentKey(h.runtime, "blocked-key", ">Restart<");
    assert.ok(key.images.at(-1)?.includes(">Restart<"), "the key asks for a plugin restart");
    await h.runtime.keys.slotPressed(key);
    assert.deepEqual(h.opened, []);
    // The view offers no Retry: the press is refused, no attempt is asked for.
    assert.equal(
      h.effects.some((effect) => effect.startsWith("retry:")),
      false,
      "no Retry from this state",
    );
    assert.equal(key.alerts, 1);
    assert.equal(h.clients.length, 1, "no client on the new address");
    await shown.acceptStrips();
    await key.settle();
    await h.runtime.shutdown();
  });
});

/*
 * Start in across a restart (C6 follow-up): the payload the first runtime
 * hands to setSettings is serialized as JSON, as Stream Deck stores and
 * delivers action settings, and given to a second, separate runtime on
 * willAppear. This proves the transport of the written payload between
 * runtime instances only, not Stream Deck's storage or SDK delivery.
 * The owner's device test confirmed the choice observed after a restart,
 * not where or how reliably it is stored. Synthetic names.
 * Alpha has two workspaces with one agent each, Beta one, Gamma none.
 */
const RESTART_HOST: Host = { ...HOST_A, agentId: "a-main-agent" };
const alphaKey = projectKey({ serverId: RESTART_HOST.serverId, projectId: "p-alpha" });

/** A live runtime over a host with three projects; agents belong through their workspaces. */
function liveProjects() {
  const harnessed = live(RESTART_HOST);
  const client = harnessed.client;
  const agent = (id: string, title: string, workspaceId: string) =>
    entry({ id, title, status: "idle", workspaceId });
  client.initialSnapshot = snapshot([
    agent("a-main-agent", "Alpha main agent", "ws-alpha-main"),
    agent("a-feature-agent", "Alpha feature agent", "ws-alpha-feature"),
    agent("b-main-agent", "Beta main agent", "ws-beta-main"),
  ]);
  client.workspaces.initialSnapshot = snapshot([
    workspacePayload({ id: "ws-alpha-main", name: "main", projectId: "p-alpha" }),
    workspacePayload({ id: "ws-alpha-feature", name: "feature", projectId: "p-alpha" }),
    workspacePayload({ id: "ws-beta-main", name: "main", projectId: "p-beta" }),
  ]);
  const project = (projectId: string, name: string) => ({
    projectId,
    projectDisplayName: name,
    projectRootPath: "/tmp/synthetic",
    projectKind: "git",
  });
  client.listedProjects = [
    project("p-alpha", "Project Alpha"),
    project("p-beta", "Project Beta"),
    project("p-gamma", "Project Gamma"),
  ];
  return harnessed;
}

/**
 * Settles one runtime: the Usage request answered, the runtime shut down
 * and every waiting strip write accepted. Registered with t.after as soon
 * as the runtime exists, so it also runs when an assertion or a wait
 * fails; it runs once, whoever calls it first. It never waits for a
 * drawing, which a failure may have prevented.
 */
function settleOnEnd(t: TestContext, harnessed: ReturnType<typeof live>) {
  let shown: Awaited<ReturnType<typeof showLive>> | null = null;
  let settled: Promise<void> | null = null;
  const settle = (): Promise<void> => {
    settled ??= (async () => {
      harnessed.usage.resolve(usagePayload(RESTART_HOST));
      await shown?.acceptStrips();
      await harnessed.runtime.shutdown();
      await shown?.acceptStrips();
    })();
    return settled;
  };
  t.after(settle);
  return {
    track: (handles: Awaited<ReturnType<typeof showLive>>) => {
      shown = handles;
    },
    settle,
  };
}

describe("Start in across a restart (a second runtime instance)", HANG_LIMIT, () => {
  it("an inspector choice is the only write; its JSON payload starts a new runtime in that project", async (t) => {
    const first = liveProjects();
    const firstEnd = settleOnEnd(t, first);
    const before = { version: 2, startIn: null, note: "synthetic", nested: { list: [1, "two"] } };
    const shown = showLive(first.runtime, RESTART_HOST, before);
    firstEnd.track(shown);
    await startLive(first, shown);
    await shown.workspace.written("All projects");

    // Turning and pressing the dial confirms Project Beta for the keys only.
    await first.runtime.workspace.rotated(shown.workspace, 2);
    await shown.acceptStrips();
    await first.runtime.workspace.pressed(shown.workspace);
    await shown.acceptStrips();
    await shown.workspace.written("Project Beta");
    assert.deepEqual(shown.workspace.settings, [], "a dial choice never writes Start in");

    // The inspector's choice is written: version 2 with the unknown fields kept.
    await first.runtime.workspace.inspectorMessage("workspace", {
      type: "choose",
      value: alphaKey,
    });
    assert.deepEqual(shown.workspace.settings, [
      {
        note: "synthetic",
        nested: { list: [1, "two"] },
        version: 2,
        startIn: { serverId: RESTART_HOST.serverId, projectId: "p-alpha" },
      },
    ]);
    const stored: unknown = JSON.parse(JSON.stringify(shown.workspace.settings[0]));
    // The first runtime is shut down before the second exists.
    await firstEnd.settle();
    assert.ok(first.effects.includes("exit"), "the first runtime is gone");

    // A separate runtime, client and dial context; only the payload crosses.
    const second = liveProjects();
    const secondEnd = settleOnEnd(t, second);
    const shownAgain = showLive(second.runtime, RESTART_HOST, stored);
    secondEnd.track(shownAgain);
    await startLive(second, shownAgain);
    await shownAgain.workspace.written("Project Alpha");
    await shownAgain.pages.written("2 agents");
    // The count is Alpha's two agents (one per workspace); the one key
    // shows an Alpha agent, never Beta's. Titles are drawn word by word.
    await shownAgain.slot.drawing(">Alpha<");
    assert.ok(
      !shownAgain.slot.images.some((image) => image.includes(">Beta<")),
      "the key shows an Alpha agent, never Beta's",
    );
    await second.runtime.workspace.inspectorShown("workspace");
    assert.equal(second.effects.at(-1), `inspector:workspace:${alphaKey}`, "Start in is Alpha");
    assert.deepEqual(shownAgain.workspace.settings, [], "the restart writes nothing");
  });

  it("a version 1 workspace Start in resolves to its project on restart and is never migrated", async (t) => {
    const harnessed = liveProjects();
    const end = settleOnEnd(t, harnessed);
    const legacy: unknown = JSON.parse(
      JSON.stringify({
        version: 1,
        startIn: { serverId: RESTART_HOST.serverId, workspaceId: "ws-alpha-feature" },
        note: "synthetic",
      }),
    );
    const shown = showLive(harnessed.runtime, RESTART_HOST, legacy);
    end.track(shown);
    await startLive(harnessed, shown);
    await shown.workspace.written("Project Alpha");
    await shown.pages.written("2 agents");
    await harnessed.runtime.workspace.inspectorShown("workspace");
    assert.equal(harnessed.effects.at(-1), `inspector:workspace:${alphaKey}`);
    assert.deepEqual(shown.workspace.settings, [], "no setSettings: no automatic migration");
  });
});
