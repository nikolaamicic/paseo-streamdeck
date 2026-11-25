import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRecord } from "../../src/agents/agent-model.ts";
import {
  Navigation,
  type NavigationFacts,
  type StripText,
} from "../../src/navigation/navigation.ts";
import {
  PagesDials,
  type PagesDialHandle,
  type PagesNavigation,
} from "../../src/spike/pages-dial.ts";
import { WorkspaceDialContexts } from "../../src/workspaces/workspace-dial-contexts.ts";
import { makeRecord, makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

/**
 * The real PagesDials (M11b2b1) with the real StripRenderer and Navigation,
 * and fake dial handles whose setFeedback waits for the test. The SDK kind
 * check (isDial) and the handle built from the SDK action stay in
 * plugin.ts's PagesDialAction and are not exercised here.
 */

const agents: AgentRecord[] = Array.from({ length: 19 }, (_, index) =>
  makeRecord({ agentId: `m${String(index).padStart(2, "0")}`, workspaceId: "w1" }),
);

/** A Pages dial whose strip sends wait for the test. */
class FakeDial implements PagesDialHandle {
  readonly id: string;
  readonly deviceId: string;
  readonly sent: string[] = [];
  readonly hints: string[] = [];
  alerts = 0;
  private readonly gates: { resolve: () => void; reject: (error: Error) => void }[] = [];
  constructor(id: string, deviceId = "dev") {
    this.id = id;
    this.deviceId = deviceId;
  }
  setFeedback(text: StripText): Promise<void> {
    this.sent.push(text.value);
    this.hints.push(text.hint);
    return new Promise((resolve, reject) => this.gates.push({ resolve, reject }));
  }
  showAlert(): Promise<void> {
    this.alerts += 1;
    return Promise.resolve();
  }
  /** Settles the send that is waiting; false when none is. */
  settle(outcome: "accept" | "fail"): boolean {
    const gate = this.gates.shift();
    if (outcome === "accept") gate?.resolve();
    else gate?.reject(new Error("raw feedback error"));
    return gate !== undefined;
  }
  get waiting(): number {
    return this.gates.length;
  }
}

function setup() {
  let facts: NavigationFacts = {
    ready: true,
    stale: false,
    link: "connected",
    serverId: SERVER_ID,
    agents,
    workspaces: [makeWorkspace({ workspaceId: "w1" })],
    truncated: false,
    agentsTruncated: false,
    projects: { status: "ready", projects: [], current: true },
  };
  const real = new Navigation(new WorkspaceDialContexts(), () => facts);
  const calls: string[] = [];
  const lines: string[] = [];
  let shuttingDown = false;
  /** The strips' send promise of the last redraw. */
  let drawn: Promise<void> = Promise.resolve();
  // Records the order of the controller's calls; the real Navigation answers.
  const navigation: PagesNavigation = {
    useDevice: (deviceId) => {
      calls.push(`useDevice:${deviceId}`);
      real.useDevice(deviceId);
    },
    rotatePages: (deviceId, ticks) => real.rotatePages(deviceId, ticks),
    pressPages: (deviceId) => real.pressPages(deviceId),
    pagesStrip: (deviceId) => real.pagesStrip(deviceId),
  };
  const dials: PagesDials = new PagesDials({
    navigation,
    shutdownStarted: () => shuttingDown,
    // As plugin.ts's renderAll: sync the navigation, then show the strips.
    renderAll: () => {
      calls.push("renderAll");
      real.sync();
      drawn = dials.showStrips();
    },
    log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
  });
  return {
    dials,
    calls,
    lines,
    drawn: () => drawn,
    setFacts: (next: Partial<NavigationFacts>) => {
      facts = { ...facts, ...next };
    },
    beginShutdown: () => {
      shuttingDown = true;
    },
  };
}

/** Accepts the waiting send of each dial, then waits for the redraw. */
async function accepted(done: Promise<void>, ...dials: FakeDial[]): Promise<void> {
  for (const dial of dials) assert.ok(dial.settle("accept"), `${dial.id} had a send waiting`);
  await done;
}

// Never needed to pass: a broken controller can leave a send no test
// accepts, and this turns that endless wait into a failure.
const HANG_LIMIT = { timeout: 10_000 };

describe("PagesDials: the Agent pages dial", HANG_LIMIT, () => {
  it("an appearing dial registers its device, then redraws and shows its page", async () => {
    const { dials, calls, drawn } = setup();
    const dial = new FakeDial("d");
    dials.appeared(dial);
    assert.deepEqual(calls, ["useDevice:dev", "renderAll"]);
    assert.deepEqual(dial.sent, ["Page 1 / 3"]);
    await accepted(drawn(), dial);
  });

  it("two controllers keep their own dials", async () => {
    const first = setup();
    const second = setup();
    const dial = new FakeDial("d");
    first.dials.appeared(dial);
    await accepted(first.drawn(), dial);
    await second.dials.rotated(dial, 1);
    await second.dials.pressed(dial);
    assert.deepEqual([second.calls, second.lines, dial.alerts], [[], [], 0], "unknown there");
    const before = first.calls.length;
    await first.dials.rotated(dial, 1);
    assert.equal(first.calls.length, before + 1, "known to the first: a redraw");
    await accepted(first.drawn(), dial);
    assert.equal(dial.sent.at(-1), "Page 2 / 3");
  });

  it("turning redraws only when the page moved, and alerts only when not current", async () => {
    const { dials, calls, drawn } = setup();
    const dial = new FakeDial("d");
    dials.appeared(dial);
    await accepted(drawn(), dial);
    const before = calls.length;
    await dials.rotated(dial, 5);
    assert.equal(calls.length, before + 1, "moved: one redraw");
    await accepted(drawn(), dial);
    assert.equal(dial.sent.at(-1), "Page 3 / 3");
    await dials.rotated(dial, 1);
    assert.deepEqual([calls.length, dial.alerts], [before + 1, 0], "unchanged: nothing");
    await dials.rotated(dial, 0.5);
    assert.deepEqual([calls.length, dial.alerts], [before + 1, 1], "not_current: alert only");
  });

  it("a press always redraws; a refresh is silent, anything else logs and alerts", async () => {
    const { dials, calls, lines, drawn, setFacts } = setup();
    const dial = new FakeDial("d");
    dials.appeared(dial);
    await accepted(drawn(), dial);
    await dials.rotated(dial, 1);
    await accepted(drawn(), dial);
    const before = calls.length;
    await dials.pressed(dial);
    assert.equal(calls.length, before + 1);
    await accepted(drawn(), dial);
    assert.deepEqual([dial.sent.at(-1), lines, dial.alerts], ["Page 1 / 3", [], 0]);

    await dials.rotated(dial, 1);
    await accepted(drawn(), dial);
    setFacts({ stale: true });
    const beforeStale = calls.length;
    await dials.pressed(dial);
    assert.equal(calls.length, beforeStale + 1, "a press that cannot sort still redraws");
    await accepted(drawn(), dial);
    assert.deepEqual([dial.sent.at(-1), dial.hints.at(-1)], ["Page 1 / 3", "Updating…"]);
    assert.deepEqual([lines, dial.alerts], [["pages dial: press_not_current"], 1]);
  });

  it("after shutdown began no dial appears", async () => {
    const { dials, calls, beginShutdown } = setup();
    beginShutdown();
    const dial = new FakeDial("d");
    dials.appeared(dial);
    await dials.rotated(dial, 1);
    await dials.pressed(dial);
    assert.deepEqual([calls, dial.sent, dial.alerts], [[], [], 0]);
  });

  it("a reappearing dial gets a fresh strip; the old one's late failure is not logged", async () => {
    const { dials, lines, drawn } = setup();
    const old = new FakeDial("d");
    dials.appeared(old);
    const oldDone = drawn();
    const fresh = new FakeDial("d");
    dials.appeared(fresh);
    assert.deepEqual(fresh.sent, ["Page 1 / 3"]);
    const freshDone = drawn();
    assert.ok(old.settle("fail"));
    await oldDone;
    assert.deepEqual(lines, [], "a disposed strip reports nothing");
    assert.ok(fresh.settle("fail"));
    await freshDone;
    assert.deepEqual(lines, ["pages dial: feedback_failed"], "the visible strip does");
    assert.deepEqual([old.waiting, fresh.waiting], [0, 0], "the old dial is sent nothing more");
  });

  it("a dial that disappears is sent nothing more; dispose forgets every dial", async () => {
    const { dials, calls, drawn } = setup();
    const gone = new FakeDial("gone");
    const kept = new FakeDial("kept");
    dials.appeared(gone);
    await accepted(drawn(), gone);
    dials.appeared(kept);
    await accepted(drawn(), kept);
    dials.disappeared("gone");
    await dials.rotated(kept, 1);
    assert.deepEqual([gone.waiting, kept.waiting], [0, 1], "only the visible dial redraws");
    await accepted(drawn(), kept);
    const before = calls.length;
    await dials.rotated(gone, 1);
    assert.equal(calls.length, before, "a turn on the gone dial does nothing");

    dials.dispose();
    await dials.rotated(kept, 1);
    await dials.pressed(kept);
    await dials.showStrips();
    assert.deepEqual([calls.length, kept.waiting, kept.alerts], [before, 0, 0]);
  });
});
