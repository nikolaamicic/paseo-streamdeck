import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Navigation,
  type NavigationFacts,
  type StripText,
} from "../../src/navigation/navigation.ts";
import { WorkspaceDials } from "../../src/spike/workspace-dial.ts";
import {
  WorkspaceDialEvents,
  type WorkspaceDialHandle,
  type WorkspaceNavigation,
} from "../../src/spike/workspace-dial-events.ts";
import { startInSettings, type StartInSettings } from "../../src/workspaces/start-in-settings.ts";
import { WorkspaceDialContexts } from "../../src/workspaces/workspace-dial-contexts.ts";
import { projectKey } from "../../src/workspaces/project-model.ts";
import { deferred, ManualScheduler } from "../support/fake-client.ts";
import { makeRecord, makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

/**
 * The real WorkspaceDialEvents (M11b2b4) over the real Navigation,
 * WorkspaceDials, contexts and StripRenderer, with fake dials whose strip
 * sends and settings writes wait for the test. The confirm guard, the
 * settings-write queue and reappear protection in detail are
 * confirm-guard.test.ts's and workspace-dial.test.ts's. The SDK kind check
 * (isDial) and the handle and payload translation stay in plugin.ts's
 * WorkspaceDial and are not exercised here.
 */

/** Beta, the project of workspace w2 (P2: the dial selects projects). */
const W2 = { serverId: SERVER_ID, projectId: "p-beta" };

/** A Workspace dial whose strip sends and settings writes wait for the test. */
class FakeDial implements WorkspaceDialHandle {
  readonly id: string;
  readonly deviceId = "dev";
  readonly stored: StartInSettings[] = [];
  alerts = 0;
  private readonly calls: string[];
  private readonly sends: { done: Promise<void>; resolve: () => void }[] = [];
  readonly writes: ReturnType<typeof deferred<undefined>>[] = [];
  /** Resolved when the first settings write starts. */
  readonly writeStarted = deferred<undefined>();
  constructor(id: string, calls: string[]) {
    this.id = id;
    this.calls = calls;
  }
  setFeedback(text: StripText): Promise<void> {
    this.calls.push(`strip:${this.id}:${text.value}`);
    let resolve: () => void = () => undefined;
    const done = new Promise<void>((accept) => {
      resolve = accept;
    });
    this.sends.push({ done, resolve });
    return done;
  }
  setSettings(settings: StartInSettings): Promise<void> {
    this.stored.push(settings);
    const write = deferred<undefined>();
    this.writes.push(write);
    this.writeStarted.resolve(undefined);
    return write.promise;
  }
  showAlert(): Promise<void> {
    this.alerts += 1;
    return Promise.resolve();
  }
  /**
   * Accepts every waiting send, oldest first, waiting for each same
   * promise. The StripRenderer awaited it first, so its bookkeeping (and a
   * queued strip it then sends) is done when that wait returns.
   */
  async acceptAll(): Promise<void> {
    for (let send = this.sends.shift(); send !== undefined; send = this.sends.shift()) {
      send.resolve();
      await send.done;
    }
  }
  get waiting(): number {
    return this.sends.length;
  }
}

function setup() {
  let facts: NavigationFacts = {
    ready: true,
    stale: false,
    link: "connected",
    serverId: SERVER_ID,
    agents: [
      makeRecord({ agentId: "a1", workspaceId: "w1" }),
      makeRecord({ agentId: "b1", workspaceId: "w2" }),
    ],
    workspaces: [
      makeWorkspace({ workspaceId: "w1", projectId: "p-alpha", name: "main" }),
      makeWorkspace({ workspaceId: "w2", projectId: "p-beta", name: "feature" }),
    ],
    truncated: false,
    agentsTruncated: false,
    projects: {
      status: "ready",
      projects: [
        { address: { serverId: SERVER_ID, projectId: "p-alpha" }, name: "Alpha" },
        { address: W2, name: "Beta" },
      ],
      current: true,
    },
  };
  const calls: string[] = [];
  const lines: string[] = [];
  const inspector: string[] = [];
  let shuttingDown = false;
  const contexts = new WorkspaceDialContexts();
  const real = new Navigation(contexts, () => facts);
  // Records the registration calls in order; the real Navigation answers.
  const navigation: WorkspaceNavigation = {
    workspaceDialShown: (contextId, deviceId) => {
      calls.push(`shown:${contextId}`);
      real.workspaceDialShown(contextId, deviceId);
    },
    workspaceDialHidden: (contextId) => {
      calls.push(`hidden:${contextId}`);
      real.workspaceDialHidden(contextId);
    },
    rotateWorkspace: (contextId, ticks) => real.rotateWorkspace(contextId, ticks),
    pressWorkspace: (contextId, shown) => real.pressWorkspace(contextId, shown),
  };
  const dials = new WorkspaceDials({
    contexts,
    timers: new ManualScheduler(),
    facts: () => ({ ...facts, connection: "ok", failure: null }),
    strip: (contextId) => real.workspaceStrip(contextId),
    retryProjects: () => false,
    sendToInspector: (context) => {
      inspector.push(context);
      return Promise.resolve();
    },
    log: (code) => lines.push(code),
  });
  const events = new WorkspaceDialEvents({
    navigation,
    dials,
    shutdownStarted: () => shuttingDown,
    // The Workspace steps of plugin.ts's renderAll: sync, then redraw.
    renderAll: () => {
      calls.push("renderAll");
      real.sync();
      dials.redraw();
    },
    log: (line) => lines.push(line),
  });
  const firstKey = () => {
    const state = real.slot("dev", 0);
    return state.kind === "agent" ? state.address.agentId : state.kind;
  };
  return {
    events,
    calls,
    lines,
    inspector,
    firstKey,
    dial: (id: string) => new FakeDial(id, calls),
    setFacts: (next: Partial<NavigationFacts>) => {
      facts = { ...facts, ...next };
    },
    beginShutdown: () => {
      shuttingDown = true;
    },
  };
}

// Never needed to pass: a broken controller can leave a send or write no
// test answers, and this turns that endless wait into a failure.
const HANG_LIMIT = { timeout: 10_000 };

describe("WorkspaceDialEvents", HANG_LIMIT, () => {
  it("registers a dial with the navigation, draws it, then redraws everything", async () => {
    const { events, calls } = setup();
    const dial = setupDial(events, calls);
    // The context resolves in the redraw's sync, so its strip comes second.
    assert.deepEqual(calls, ["shown:d", "strip:d:Loading…", "renderAll"]);
    await dial.acceptAll();
    assert.equal(calls.at(-1), "strip:d:All projects");
  });

  it("after shutdown began no dial appears", () => {
    const { events, calls, dial, beginShutdown } = setup();
    beginShutdown();
    events.appeared(dial("d"), {});
    assert.deepEqual(calls, []);
  });

  it("a dial that disappears leaves the navigation, then is forgotten, then all redraw", async () => {
    const { events, calls } = setup();
    const dial = setupDial(events, calls);
    await dial.acceptAll();
    calls.length = 0;
    events.disappeared("d");
    assert.deepEqual(calls, ["hidden:d", "renderAll"], "the gone dial is drawn nothing");
    assert.equal(dial.waiting, 0);
  });

  it("settings from Stream Deck apply before the redraw that shows them", async () => {
    const { events, calls, firstKey } = setup();
    const dial = setupDial(events, calls);
    await dial.acceptAll();
    calls.length = 0;
    events.settingsReceived("d", startInSettings(W2));
    assert.equal(calls.at(-1), "renderAll");
    await dial.acceptAll();
    assert.equal(calls.filter((call) => call.startsWith("strip:")).at(-1), "strip:d:Beta");
    assert.equal(firstKey(), "b1", "the keys show the new Start in");
  });

  it("turning previews only and redraws; a press waits for the preview's strip", async () => {
    const { events, calls, lines, firstKey } = setup();
    const dial = setupDial(events, calls);
    await dial.acceptAll();
    const before = calls.length;
    await events.rotated(dial, 2);
    assert.deepEqual(calls.slice(before), ["renderAll", "strip:d:Beta"]);
    assert.deepEqual([firstKey(), dial.alerts, lines], ["a1", 0, []], "only a preview");

    await events.pressed(dial);
    assert.deepEqual([lines, dial.alerts], [["workspace dial: press_not_shown"], 1]);
    assert.equal(firstKey(), "a1", "a preview not yet accepted is not confirmed");
    assert.equal(calls.at(-1), "renderAll", "a refused press still redraws");

    await dial.acceptAll();
    await events.pressed(dial);
    assert.deepEqual([firstKey(), dial.alerts], ["b1", 1], "committed: no alert");
    await dial.acceptAll();
  });

  it("a press without a preview refreshes silently", async () => {
    const { events, calls, lines } = setup();
    const dial = setupDial(events, calls);
    await dial.acceptAll();
    const before = calls.length;
    await events.pressed(dial);
    assert.deepEqual([calls.slice(before), lines, dial.alerts], [["renderAll"], [], 0]);
  });

  it("two dials on one device conflict: turns and presses log and alert", async () => {
    const { events, calls, lines } = setup();
    const first = setupDial(events, calls, "first");
    const second = setupDial(events, calls, "second");
    await first.acceptAll();
    await second.acceptAll();
    await events.rotated(first, 1);
    await events.pressed(second);
    assert.deepEqual(lines, ["workspace dial: rotate_conflict", "workspace dial: press_conflict"]);
    assert.deepEqual([first.alerts, second.alerts], [1, 1]);
    await first.acceptAll();
    await second.acceptAll();
  });

  it("a turn on data that is not current logs and alerts, after redrawing", async () => {
    const { events, calls, lines, setFacts } = setup();
    const dial = setupDial(events, calls);
    await dial.acceptAll();
    setFacts({ stale: true });
    const before = calls.length;
    await events.rotated(dial, 1);
    assert.equal(calls[before], "renderAll");
    assert.deepEqual([lines, dial.alerts], [["workspace dial: rotate_not_current"], 1]);
    await dial.acceptAll();
  });

  it("an inspector that appears is sent its view", async () => {
    const { events, calls, lines, inspector } = setup();
    const dial = setupDial(events, calls);
    await dial.acceptAll();
    const sent = inspector.length;
    await events.inspectorShown("d");
    assert.equal(inspector.length, sent + 1);
    assert.equal(lines.at(-1), "inspector_shown");
  });

  it("an inspector choice is written before the redraw that applies it", async () => {
    const { events, calls, firstKey } = setup();
    const dial = setupDial(events, calls);
    await dial.acceptAll();
    const before = calls.length;
    const message = events.inspectorMessage("d", { type: "choose", value: projectKey(W2) });
    await dial.writeStarted.promise;
    assert.deepEqual(dial.stored, [startInSettings(W2)]);
    assert.deepEqual(calls.slice(before), [], "no redraw while the write is pending");
    dial.writes[0]?.resolve(undefined);
    await message;
    assert.equal(calls.at(-1), "renderAll");
    assert.equal(firstKey(), "b1");
    await dial.acceptAll();
  });
});

function setupDial(events: WorkspaceDialEvents, calls: string[], id = "d"): FakeDial {
  const dial = new FakeDial(id, calls);
  events.appeared(dial, {});
  return dial;
}
