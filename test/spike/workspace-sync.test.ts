import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Navigation, type NavigationFacts } from "../../src/navigation/navigation.ts";
import { WorkspaceDials, type DialHandle } from "../../src/spike/workspace-dial.ts";
import { startInSettings } from "../../src/workspaces/start-in-settings.ts";
import { WorkspaceDialContexts } from "../../src/workspaces/workspace-dial-contexts.ts";
import { projectKey } from "../../src/workspaces/project-model.ts";
import type { ChoiceSource } from "../../src/workspaces/project-selection.ts";
import { ManualScheduler } from "../support/fake-client.ts";
import { makeRecord, makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

/**
 * Who resolves the Project dial contexts (M8; projects since P2, each
 * project here has one workspace), with the real Navigation
 * and WorkspaceDials wired as plugin.ts wires them: the strip text comes
 * from the navigation, and the full render syncs the navigation first.
 * Strip views are recorded when a dial asks for them, which happens
 * synchronously, so no microtask flushing is needed.
 */

const at = (projectId: string) => ({ serverId: SERVER_ID, projectId });

class FakeDial implements DialHandle {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  setSettings(): Promise<void> {
    return Promise.resolve();
  }
  setFeedback(): Promise<void> {
    return Promise.resolve();
  }
}

function setup() {
  let facts: NavigationFacts = {
    ready: true,
    stale: false,
    link: "connected",
    serverId: SERVER_ID,
    agents: [makeRecord({ agentId: "a1", workspaceId: "w1" })],
    workspaces: [
      makeWorkspace({ workspaceId: "w1", projectId: "p-alpha" }),
      makeWorkspace({ workspaceId: "w2", projectId: "p-beta" }),
    ],
    truncated: false,
    agentsTruncated: false,
    projects: {
      status: "ready",
      projects: [
        { address: at("p-alpha"), name: "Alpha" },
        { address: at("p-beta"), name: "Beta" },
      ],
      current: true,
    },
  };
  const contexts = new WorkspaceDialContexts();
  const syncs: string[][] = [];
  const realSync = contexts.sync.bind(contexts);
  contexts.sync = (source: ChoiceSource) => {
    const changed = realSync(source);
    syncs.push(changed);
    return changed;
  };
  const navigation = new Navigation(contexts, () => facts);
  const requested: string[] = [];
  const dials = new WorkspaceDials({
    contexts,
    timers: new ManualScheduler(),
    facts: () => ({ ...facts, connection: "ok", failure: null }),
    strip: (contextId) => {
      const view = navigation.workspaceStrip(contextId);
      requested.push(view.text.value);
      return view;
    },
    sendToInspector: () => Promise.resolve(),
    retryProjects: () => false,
    log: () => undefined,
  });
  /** As plugin.ts renderAll: navigation first, then the Workspace dials. */
  const render = () => {
    navigation.sync();
    dials.redraw();
  };
  const show = (dial: DialHandle, settings: unknown) => {
    navigation.workspaceDialShown(dial.id, "dev");
    dials.appear(dial, settings);
    render();
  };
  return {
    contexts,
    navigation,
    dials,
    syncs,
    requested,
    render,
    show,
    setFacts: (next: Partial<NavigationFacts>) => {
      facts = { ...facts, ...next };
    },
  };
}

describe("Project dial context sync ownership", () => {
  it("a full render resolves the contexts in Navigation.sync; a later sync changes nothing", () => {
    const { syncs, requested, render, show } = setup();
    show(new FakeDial("dial"), startInSettings(at("p-alpha")));
    assert.equal(requested.at(-1), "Alpha");
    const first = syncs.length;
    render();
    const inRender = syncs.slice(first);
    assert.deepEqual(inRender[0], [], "already resolved for this host");
    assert.ok(inRender.every((changed) => changed.length === 0));
  });

  it("a full render syncs the contexts once: redraw does not sync again", () => {
    const { syncs, requested, render, show, dials } = setup();
    show(new FakeDial("dial"), startInSettings(at("p-alpha")));
    const before = syncs.length;
    render();
    assert.equal(syncs.length - before, 1, "only Navigation.sync");
    dials.redraw();
    assert.equal(syncs.length - before, 1);
    assert.equal(requested.at(-1), "Alpha");
  });

  it("a host change is resolved by the navigation before the dial is drawn", () => {
    const { syncs, requested, render, show, setFacts } = setup();
    show(new FakeDial("dial"), startInSettings(at("p-alpha")));
    setFacts({
      serverId: "srv_OtherHost02",
      workspaces: [],
      projects: { status: "ready", projects: [], current: true },
    });
    const before = syncs.length;
    render();
    assert.deepEqual(syncs[before], ["dial"], "the navigation's sync resolves the new host");
    // P2: a saved project of another host is shown unresolved, never All.
    assert.equal(requested.at(-1), "Other host");
  });

  it("after a sent Start in, the dial shows it before any full render", async () => {
    const { dials, requested, show } = setup();
    show(new FakeDial("dial"), startInSettings(at("p-alpha")));
    await dials.request("dial", { type: "choose", value: projectKey(at("p-beta")) });
    assert.equal(requested.at(-1), "Beta", "resolved right after the write");
  });

  it("settings from Stream Deck show Loading until the next full render resolves them", () => {
    const { dials, requested, render, show } = setup();
    show(new FakeDial("dial"), startInSettings(at("p-alpha")));
    dials.settingsReceived("dial", startInSettings(at("p-beta")));
    assert.equal(requested.at(-1), "Loading…", "a new Start in is not resolved by itself");
    render();
    assert.equal(requested.at(-1), "Beta");
  });

  it("a standalone refresh still resolves the contexts", () => {
    const { contexts, dials } = setup();
    contexts.appear("dial", startInSettings(at("p-beta")));
    dials.appear(new FakeDial("dial"), startInSettings(at("p-beta")));
    dials.refresh();
    assert.deepEqual(contexts.choice("dial")?.selection, {
      kind: "project",
      address: at("p-beta"),
    });
  });
});
