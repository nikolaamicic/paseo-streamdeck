import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Navigation,
  type NavigationFacts,
  type StripText,
} from "../../src/navigation/navigation.ts";
import { WorkspaceDials, type DialHandle } from "../../src/spike/workspace-dial.ts";
import { WorkspaceDialContexts } from "../../src/workspaces/workspace-dial-contexts.ts";
import { FOOTER_SCROLL } from "../../src/spike/footer-scroll.ts";
import { flush, ManualScheduler } from "../support/fake-client.ts";
import { makeRecord, makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

/**
 * The Project dial press (the action with the `…workspace` UUID; adapted to
 * projects in P2, each project here has one workspace) goes through the
 * same objects and calls as plugin.ts:
 * strips are sent by WorkspaceDials, and a press passes
 * workspaceDials.shownStrip(id) to navigation.pressWorkspace.
 */

/** A dial whose setFeedback calls stay pending until the test settles them. */
class GatedDial implements DialHandle {
  readonly id: string;
  readonly pending: { text: StripText; settle: (ok: boolean) => void }[] = [];
  /** Texts whose send was accepted, in order. */
  readonly sent: StripText[] = [];

  constructor(id: string) {
    this.id = id;
  }

  setSettings(): Promise<void> {
    return Promise.resolve();
  }

  setFeedback(text: StripText): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        text,
        settle: (ok) => {
          if (ok) this.sent.push(text);
          if (ok) resolve();
          else reject(new Error("raw"));
        },
      });
    });
  }

  /** Settles every pending send. */
  async settleAll(ok = true): Promise<void> {
    while (this.pending.length > 0) {
      this.pending.shift()?.settle(ok);
      await flush();
    }
  }
}

const project = (projectId: string, name: string) => ({
  address: { serverId: SERVER_ID, projectId },
  name,
});
const ALPHA = project("p-alpha", "Alpha");
const BETA = project("p-beta", "Beta");
const projectsState = (...projects: ReturnType<typeof project>[]) => ({
  status: "ready" as const,
  projects,
  current: true,
});

function setup() {
  const facts: { -readonly [K in keyof NavigationFacts]: NavigationFacts[K] } = {
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
    projects: projectsState(ALPHA, BETA),
  };
  const contexts = new WorkspaceDialContexts();
  const navigation = new Navigation(contexts, () => facts);
  const logs: string[] = [];
  const clock = new ManualScheduler();
  const dials = new WorkspaceDials({
    contexts,
    timers: clock,
    facts: () => ({ ...facts, connection: "ok", failure: null }),
    strip: (contextId) => navigation.workspaceStrip(contextId),
    sendToInspector: () => Promise.resolve(),
    retryProjects: () => false,
    log: (code) => logs.push(code),
  });
  const renderAll = () => {
    navigation.sync();
    dials.redraw();
  };
  const show = (dial: GatedDial) => {
    navigation.workspaceDialShown(dial.id, "dev");
    dials.appear(dial, {});
    renderAll();
  };
  const hide = (id: string) => {
    navigation.workspaceDialHidden(id);
    dials.disappear(id);
    renderAll();
  };
  const turn = (id: string, ticks: number) => {
    navigation.rotateWorkspace(id, ticks);
    renderAll();
  };
  const press = (id: string) => {
    const result = navigation.pressWorkspace(id, dials.shownStrip(id));
    renderAll();
    return result;
  };
  const firstKey = () => {
    const state = navigation.slot("dev", 0);
    return state.kind === "agent" ? state.address.agentId : state.kind;
  };
  return {
    show,
    hide,
    turn,
    press,
    firstKey,
    logs,
    clock,
    setFacts: (next: Partial<NavigationFacts>) => Object.assign(facts, next),
    renderAll,
  };
}

describe("Project dial confirm guard", () => {
  it("refuses a press while the preview's strip is still being sent", async () => {
    const { show, turn, press, firstKey } = setup();
    const dial = new GatedDial("dial");
    show(dial);
    await dial.settleAll();
    turn("dial", 2);
    assert.equal(dial.pending.at(-1)?.text.value, "Beta");
    assert.equal(press("dial"), "not_shown", "quick turn and press");
    assert.equal(firstKey(), "a1", "the keys did not switch");
    await dial.settleAll();
    assert.equal(press("dial"), "committed");
    assert.equal(firstKey(), "b1");
  });

  it("refuses a press after the strip failed to send, until a new strip is accepted", async () => {
    const { show, turn, press, firstKey, logs } = setup();
    const dial = new GatedDial("dial");
    show(dial);
    await dial.settleAll();
    turn("dial", 1);
    await dial.settleAll(false);
    assert.ok(logs.includes("dial_feedback_failed"));
    assert.equal(press("dial"), "not_shown");
    assert.equal(firstKey(), "a1");
    turn("dial", 1);
    await dial.settleAll();
    assert.equal(press("dial"), "committed", "the newly shown preview");
    assert.equal(firstKey(), "b1");
  });

  it("does not let an old instance's completed send certify a reappeared dial", async () => {
    const { show, hide, turn, press, firstKey } = setup();
    const old = new GatedDial("dial");
    show(old);
    await old.settleAll();
    turn("dial", 2);
    hide("dial");
    const fresh = new GatedDial("dial");
    show(fresh);
    turn("dial", 2);
    await old.settleAll();
    assert.equal(press("dial"), "not_shown", "the old completion counts for nothing");
    assert.equal(firstKey(), "a1");
    await fresh.settleAll();
    assert.equal(press("dial"), "committed");
  });
});

describe("Project dial press refresh guard", () => {
  it("does not refresh while the strip may still show a preview", async () => {
    const { show, turn, press, firstKey, setFacts, renderAll } = setup();
    const dial = new GatedDial("dial");
    show(dial);
    await dial.settleAll();
    turn("dial", 2);
    await dial.settleAll();
    turn("dial", -2);
    assert.equal(dial.pending.at(-1)?.text.value, "All projects", "back, not yet accepted");
    setFacts({
      agents: [
        makeRecord({ agentId: "a1", workspaceId: "w1" }),
        makeRecord({ agentId: "b1", workspaceId: "w2", status: "running" }),
      ],
    });
    renderAll();
    assert.equal(press("dial"), "not_shown", "the preview may still be on the strip");
    assert.equal(firstKey(), "a1", "neither confirmed nor sorted");
    await dial.settleAll();
    assert.equal(press("dial"), "refreshed");
    assert.equal(firstKey(), "b1", "the running agent comes first");
  });
});

describe("long names on the Project strip", () => {
  const longProject = project("p-long", "A very long project name for the touch strip, to scroll");
  const longWorkspace = makeWorkspace({ workspaceId: "w2", projectId: "p-long" });

  it("scrolls a long previewed name, and a frame in flight does not block its confirm", async () => {
    const { show, turn, press, firstKey, clock, setFacts, renderAll } = setup();
    setFacts({
      workspaces: [makeWorkspace({ workspaceId: "w1", projectId: "p-alpha" }), longWorkspace],
      projects: projectsState(ALPHA, longProject),
    });
    const dial = new GatedDial("dial");
    show(dial);
    renderAll();
    await dial.settleAll();
    // Sorted by name: the long project comes right after All.
    turn("dial", 1);
    await dial.settleAll();
    clock.advance(FOOTER_SCROLL.pauseMs + 4 * FOOTER_SCROLL.frameMs);
    const frame = dial.pending.at(-1);
    assert.ok(frame, "a scroll frame is being sent");
    assert.notEqual(frame.text.value, longProject.name, "the name starts further in");
    assert.ok(longProject.name.endsWith(frame.text.value));
    assert.equal(press("dial"), "committed", "same preview, only the text moved");
    assert.equal(firstKey(), "b1");
  });

  it("keeps the name's position when only the hint changes, and stops on disappear", async () => {
    const { show, hide, turn, clock, setFacts, renderAll } = setup();
    setFacts({
      workspaces: [makeWorkspace({ workspaceId: "w1", projectId: "p-alpha" }), longWorkspace],
      projects: projectsState(ALPHA, longProject),
    });
    const dial = new GatedDial("dial");
    show(dial);
    await dial.settleAll();
    // Sorted by name: the long project comes right after All.
    turn("dial", 1);
    await dial.settleAll();
    clock.advance(FOOTER_SCROLL.pauseMs + 4 * FOOTER_SCROLL.frameMs);
    await dial.settleAll();
    const before = dial.sent.at(-1)?.value;
    setFacts({ link: "reconnecting" });
    renderAll();
    await dial.settleAll();
    assert.notEqual(before, longProject.name, "the name had scrolled");
    assert.equal(dial.sent.at(-1)?.hint, "Offline");
    assert.equal(dial.sent.at(-1)?.value, before, "a status change does not restart the name");
    hide("dial");
    assert.equal(clock.pendingTimers, 0, "no timer left after the dial disappears");
  });
});
