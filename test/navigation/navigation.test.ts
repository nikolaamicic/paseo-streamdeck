import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRecord } from "../../src/agents/agent-model.ts";
import { Navigation, type NavigationFacts } from "../../src/navigation/navigation.ts";
import { KeyRenderer } from "../../src/spike/key-renderer.ts";
import { keySvg } from "../../src/spike/key-svg.ts";
import { slotKeyView, type KeyView } from "../../src/spike/key-view.ts";
import { decidePress } from "../../src/spike/press-guard.ts";
import type { ProjectsState } from "../../src/paseo/project-sync.ts";
import type { ProjectRecord } from "../../src/workspaces/project-model.ts";
import { START_IN_ALL, startInSettings } from "../../src/workspaces/start-in-settings.ts";
import { WorkspaceDialContexts } from "../../src/workspaces/workspace-dial-contexts.ts";
import { deferred, flush } from "../support/fake-client.ts";
import { makeRecord, makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

const OTHER_HOST = "srv_OtherHost02";

/*
 * Adapted from the workspace dial (P2, intended semantics): the dial now
 * selects projects. Here each project has one workspace (Alpha: w1, Beta:
 * w2), so the key expectations are unchanged; strip texts name projects.
 * Projects across several workspaces: project-navigation.test.ts.
 */
const project = (projectId: string, name: string, serverId = SERVER_ID): ProjectRecord => ({
  address: { serverId, projectId },
  name,
});
const ALPHA = project("p-alpha", "Alpha");
const BETA = project("p-beta", "Beta");
const ready = (...projects: ProjectRecord[]): ProjectsState => ({
  status: "ready",
  projects,
  current: true,
});
const startIn = (projectId: string) => startInSettings({ serverId: SERVER_ID, projectId });

/** Presses as if the dial's current strip was accepted by Stream Deck. */
const confirm = (navigation: Navigation, contextId: string) =>
  navigation.pressWorkspace(contextId, { preview: navigation.workspaceStrip(contextId).preview });

const agent = (agentId: string, workspaceId: string | null, serverId = SERVER_ID): AgentRecord => ({
  ...makeRecord({ agentId, workspaceId }),
  address: { serverId, agentId },
});

const WORKSPACES = [
  makeWorkspace({ workspaceId: "w1", projectId: "p-alpha", projectName: "Alpha", name: "main" }),
  makeWorkspace({ workspaceId: "w2", projectId: "p-beta", projectName: "Beta", name: "feature" }),
];
const AGENTS = [agent("a1", "w1"), agent("a2", "w1"), agent("b1", "w2"), agent("loose", null)];

function setup(overrides: Partial<NavigationFacts> = {}) {
  let facts: NavigationFacts = {
    ready: true,
    stale: false,
    link: "connected",
    serverId: SERVER_ID,
    agents: AGENTS,
    workspaces: WORKSPACES,
    truncated: false,
    agentsTruncated: false,
    projects: ready(ALPHA, BETA),
    ...overrides,
  };
  const contexts = new WorkspaceDialContexts();
  const navigation = new Navigation(contexts, () => facts);
  const showDial = (contextId: string, deviceId: string, settings: unknown = {}) => {
    contexts.appear(contextId, settings);
    navigation.workspaceDialShown(contextId, deviceId);
    navigation.sync();
  };
  const hideDial = (contextId: string) => {
    navigation.workspaceDialHidden(contextId);
    contexts.disappear(contextId);
    navigation.sync();
  };
  /** Agent IDs on the eight keys of a device; null for an empty key. */
  const keys = (deviceId = "dev") =>
    Array.from({ length: 8 }, (_, slot) => {
      const state = navigation.slot(deviceId, slot);
      return state.kind === "agent" ? state.address.agentId : state.kind === "empty" ? null : "…";
    });
  const setFacts = (next: Partial<NavigationFacts>, sync = true) => {
    facts = { ...facts, ...next };
    if (sync) navigation.sync();
  };
  return { navigation, contexts, showDial, hideDial, keys, setFacts };
}

const ALL_KEYS = ["a1", "a2", "b1", "loose", null, null, null, null];
const W1_KEYS = ["a1", "a2", null, null, null, null, null, null];

describe("Navigation: preview and confirm", () => {
  it("turning only previews; pressing confirms and shows that workspace's agents", () => {
    const { navigation, contexts, showDial, keys } = setup();
    showDial("dial", "dev");
    assert.deepEqual(keys(), ALL_KEYS);
    assert.deepEqual(navigation.workspaceStrip("dial").text, {
      label: { value: "Project", color: "#a6a6ae" },
      value: "All projects",
      hint: "4 agents · turn to browse",
    });

    assert.equal(navigation.rotateWorkspace("dial", 1), "moved");
    assert.deepEqual(keys(), ALL_KEYS, "the keys keep the confirmed workspace");
    assert.deepEqual(navigation.workspaceStrip("dial").text, {
      label: { value: "Preview: press dial", color: "#f0b44c" },
      value: "Alpha",
      hint: "2 agents",
    });

    assert.equal(confirm(navigation, "dial"), "committed");
    assert.deepEqual(keys(), W1_KEYS);
    assert.deepEqual(navigation.workspaceStrip("dial").text, {
      label: { value: "Project", color: "#a6a6ae" },
      value: "Alpha",
      hint: "2 agents",
    });
    assert.equal(contexts.startIn("dial"), START_IN_ALL, "confirming never changes Start in");
  });

  it("All projects is an ordinary entry; turning back to the confirmed one ends the preview", () => {
    const { navigation, showDial, keys } = setup();
    showDial("dial", "dev", startIn("p-alpha"));
    assert.deepEqual(keys(), W1_KEYS, "Start in is the startup default");
    navigation.rotateWorkspace("dial", -1);
    assert.equal(navigation.workspaceStrip("dial").text.value, "All projects");
    assert.equal(confirm(navigation, "dial"), "committed");
    assert.deepEqual(keys(), ALL_KEYS);

    navigation.rotateWorkspace("dial", 2);
    navigation.rotateWorkspace("dial", -2);
    assert.equal(navigation.workspaceStrip("dial").text.label.value, "Project");
    assert.equal(confirm(navigation, "dial"), "refreshed", "no preview: a refresh");
    assert.deepEqual(keys(), ALL_KEYS);
  });

  it("refuses to preview or confirm from a list that is not current", () => {
    const { navigation, showDial, keys, setFacts } = setup();
    showDial("dial", "dev");
    navigation.rotateWorkspace("dial", 1);
    for (const facts of [{ stale: true }, { link: "reconnecting" as const }]) {
      setFacts(facts);
      assert.equal(navigation.rotateWorkspace("dial", 1), "not_current");
      assert.equal(confirm(navigation, "dial"), "not_current");
      assert.deepEqual(keys(), ALL_KEYS, "nothing switches");
      setFacts({ stale: false, link: "connected" });
    }
    assert.equal(confirm(navigation, "dial"), "committed", "the preview survived");
  });

  it("shows Offline or Updating on both strips during a preview, and recovers", () => {
    const { navigation, showDial, setFacts } = setup();
    showDial("dial", "dev");
    navigation.rotateWorkspace("dial", 1);
    for (const [facts, status] of [
      [{ link: "reconnecting" as const }, "Offline"],
      [{ stale: true }, "Updating…"],
    ] as const) {
      setFacts(facts);
      assert.deepEqual(navigation.workspaceStrip("dial"), {
        text: { label: { value: "Preview", color: "#f0b44c" }, value: "Alpha", hint: status },
        preview: navigation.workspaceStrip("dial").preview,
      });
      assert.notEqual(navigation.workspaceStrip("dial").preview, null, "the candidate is kept");
      assert.equal(navigation.pagesStrip("dev").hint, status);
      assert.equal(confirm(navigation, "dial"), "not_current");
      setFacts({ link: "connected", stale: false });
    }
    assert.deepEqual(navigation.workspaceStrip("dial").text, {
      label: { value: "Preview: press dial", color: "#f0b44c" },
      value: "Alpha",
      hint: "2 agents",
    });
    assert.equal(navigation.pagesStrip("dev").hint, "4 agents · press: refresh");
    assert.equal(confirm(navigation, "dial"), "committed");
  });

  it("drops a preview whose project disappears and never confirms a removed one", () => {
    const { navigation, showDial, keys, setFacts } = setup();
    showDial("dial", "dev");
    navigation.rotateWorkspace("dial", 2);
    assert.equal(navigation.workspaceStrip("dial").text.value, "Beta");
    setFacts({ projects: ready(ALPHA) });
    assert.equal(
      navigation.workspaceStrip("dial").text.label.value,
      "Project",
      "preview dropped on sync",
    );

    setFacts({ projects: ready(ALPHA, BETA) });
    navigation.rotateWorkspace("dial", 2);
    // Removed between two syncs: the press itself checks the current list.
    setFacts({ projects: ready(ALPHA) }, false);
    assert.equal(confirm(navigation, "dial"), "removed");
    assert.deepEqual(keys(), ALL_KEYS);
  });

  it("on a host change drops the preview, shows loading, then the new host's agents", () => {
    const { navigation, showDial, keys, setFacts } = setup();
    showDial("dial", "dev");
    navigation.rotateWorkspace("dial", 1);
    setFacts({
      serverId: OTHER_HOST,
      stale: true,
      agents: [agent("x1", "wx", OTHER_HOST)],
      workspaces: [makeWorkspace({ workspaceId: "wx", serverId: OTHER_HOST })],
      projects: ready(),
    });
    assert.deepEqual(keys(), Array(8).fill("…"), "another host's layout is never shown");
    assert.equal(navigation.workspaceStrip("dial").text.value, "Loading…");
    setFacts({ stale: false });
    assert.deepEqual(keys(), ["x1", null, null, null, null, null, null, null]);
    assert.deepEqual(navigation.workspaceStrip("dial").text, {
      label: { value: "Project", color: "#a6a6ae" },
      value: "All projects",
      hint: "1 agent · turn to browse",
    });
  });

  it("a saved project of another host stays visibly unresolved after a host change, never All", () => {
    const { navigation, showDial, keys, setFacts } = setup();
    showDial("dial", "dev", startIn("p-alpha"));
    setFacts({
      serverId: OTHER_HOST,
      stale: true,
      agents: [agent("x1", "wx", OTHER_HOST)],
      workspaces: [makeWorkspace({ workspaceId: "wx", serverId: OTHER_HOST })],
      projects: ready(),
    });
    setFacts({ stale: false });
    assert.deepEqual(keys(), Array(8).fill(null), "no agents shown for an unresolved Start in");
    assert.deepEqual(navigation.workspaceStrip("dial").text, {
      label: { value: "Project", color: "#a6a6ae" },
      value: "Other host",
      hint: "Start in not found · turn to choose",
    });
    assert.equal(navigation.rotateWorkspace("dial", -1), "moved", "turning starts from All");
    assert.equal(navigation.rotateWorkspace("dial", 1), "moved");
    assert.equal(navigation.workspaceStrip("dial").text.value, "All projects");
    assert.equal(confirm(navigation, "dial"), "committed");
    assert.deepEqual(keys(), ["x1", null, null, null, null, null, null, null]);
  });
});

describe("Navigation: an agent that leaves the shown project (§6 rule 6)", () => {
  it("stays in place dimmed until the next relayout, and is not counted", () => {
    const { navigation, showDial, keys, setFacts } = setup();
    showDial("dial", "dev", startIn("p-alpha"));
    assert.deepEqual(keys(), W1_KEYS);
    setFacts({ agents: [agent("a1", "w2"), agent("a2", "w1"), agent("b1", "w2")] });
    assert.deepEqual(keys(), W1_KEYS, "a1 keeps its key");
    assert.deepEqual(navigation.slot("dev", 0), {
      kind: "agent",
      address: { serverId: SERVER_ID, agentId: "a1" },
      dimmed: true,
    });
    assert.deepEqual(navigation.slot("dev", 1), {
      kind: "agent",
      address: { serverId: SERVER_ID, agentId: "a2" },
      dimmed: false,
    });
    assert.equal(navigation.workspaceStrip("dial").text.hint, "1 agent");

    // Confirming All and then w1 again re-arranges w1: a1 is no longer there.
    navigation.rotateWorkspace("dial", -1);
    assert.equal(confirm(navigation, "dial"), "committed");
    navigation.rotateWorkspace("dial", 1);
    assert.equal(confirm(navigation, "dial"), "committed");
    assert.deepEqual(keys(), ["a2", null, null, null, null, null, null, null], "relayout");
  });

  it("is drawn dimmed on its key", () => {
    const record = agent("a1", "w2");
    const view = slotKeyView({
      connection: "ok",
      link: "connected",
      stale: false,
      failure: null,
      recoveryError: null,
      retryAvailable: false,
      serverId: SERVER_ID,
      hasSnapshot: true,
      dimmed: true,
      slot: record.address,
      record,
    });
    assert.deepEqual(view.identity, record.address, "a press still opens that agent");
    assert.equal(view.face.kind === "agent" && view.face.dimmed, true);
    assert.match(keySvg(view.face), /opacity="0\.6"/);
  });
});

describe("Navigation: pages", () => {
  const many = Array.from({ length: 19 }, (_, index) =>
    agent(`m${String(index).padStart(2, "0")}`, "w1"),
  );

  it("pages through more than eight agents without wrapping; press returns to page 1", () => {
    const { navigation, showDial, keys } = setup({ agents: many });
    showDial("dial", "dev");
    assert.deepEqual(navigation.pagesStrip("dev"), {
      label: { value: "Agent pages", color: "#a6a6ae" },
      value: "Page 1 / 3",
      hint: "19 agents · press: refresh",
    });
    assert.equal(navigation.rotatePages("dev", 5), "moved");
    assert.equal(navigation.pagesStrip("dev").value, "Page 3 / 3");
    assert.deepEqual(keys(), ["m16", "m17", "m18", null, null, null, null, null]);
    assert.equal(navigation.rotatePages("dev", 1), "unchanged", "no wrap past the end");
    assert.equal(navigation.pressPages("dev"), "refreshed");
    assert.equal(keys()[0], "m00");
  });

  it("keeps the page when agents change and clamps it when pages disappear", () => {
    const { navigation, showDial, keys, setFacts } = setup({ agents: many });
    showDial("dial", "dev");
    navigation.rotatePages("dev", 2);
    setFacts({ agents: many.filter((record) => record.address.agentId !== "m05") });
    assert.equal(navigation.pagesStrip("dev").value, "Page 3 / 3", "a hole keeps positions");
    // m05 stays away: a returning agent would be new and go to the end (§6 rule 5).
    setFacts({ agents: many.slice(0, 10).filter((record) => record.address.agentId !== "m05") });
    assert.equal(navigation.pagesStrip("dev").value, "Page 2 / 2");
    assert.deepEqual(keys(), ["m08", "m09", null, null, null, null, null, null]);
  });

  it("a confirmed project starts on page 1", () => {
    const { navigation, showDial, keys } = setup({ agents: [...many, agent("b1", "w2")] });
    showDial("dial", "dev");
    navigation.rotatePages("dev", 1);
    navigation.rotateWorkspace("dial", 2);
    confirm(navigation, "dial");
    assert.equal(navigation.pagesStrip("dev").value, "Page 1 / 1");
    assert.equal(keys()[0], "b1");
  });
});

describe("Navigation: devices and dial lifecycle", () => {
  it("with two Project dials on one device neither controls the keys", () => {
    const { navigation, showDial, hideDial, keys } = setup();
    showDial("left", "dev");
    navigation.rotateWorkspace("left", 1);
    confirm(navigation, "left");
    showDial("right", "dev", startIn("p-beta"));
    assert.deepEqual(keys(), W1_KEYS, "the keys keep the last confirmed project");
    for (const dial of ["left", "right"]) {
      assert.equal(navigation.rotateWorkspace(dial, 1), "conflict");
      assert.equal(confirm(navigation, dial), "conflict");
      assert.equal(navigation.workspaceStrip(dial).text.value, "Two dials");
    }
    hideDial("left");
    assert.deepEqual(keys(), ["b1", null, null, null, null, null, null, null], "one dial again");
  });

  it("keeps devices apart", () => {
    const { navigation, showDial, keys } = setup();
    showDial("dial-1", "dev-1");
    showDial("dial-2", "dev-2");
    navigation.rotateWorkspace("dial-1", 1);
    confirm(navigation, "dial-1");
    assert.deepEqual(keys("dev-1"), W1_KEYS);
    assert.deepEqual(keys("dev-2"), ALL_KEYS);
  });

  it("keeps the confirmed project while the dial is hidden and after it returns", () => {
    const { navigation, contexts, showDial, hideDial, keys } = setup();
    showDial("dial", "dev");
    navigation.rotateWorkspace("dial", 1);
    confirm(navigation, "dial");
    navigation.rotateWorkspace("dial", 1);
    hideDial("dial");
    assert.deepEqual(keys(), W1_KEYS, "no dial: the keys keep it");
    showDial("dial", "dev");
    assert.deepEqual(keys(), W1_KEYS, "page or profile switch back");
    assert.equal(
      navigation.workspaceStrip("dial").text.label.value,
      "Project",
      "the preview is gone",
    );

    hideDial("dial");
    contexts.appear("dial", startIn("p-beta"));
    navigation.workspaceDialShown("dial", "dev");
    navigation.sync();
    assert.deepEqual(keys(), ["b1", null, null, null, null, null, null, null], "new Start in");
  });

  it("keys on a device without a Project dial show all projects", () => {
    const { navigation, keys } = setup();
    navigation.useDevice("dev");
    navigation.sync();
    assert.deepEqual(keys(), ALL_KEYS);
  });
});

describe("Navigation: presses during renders", () => {
  const feed = {
    connection: "ok" as const,
    link: "connected" as const,
    stale: false,
    failure: null,
    recoveryError: null,
    retryAvailable: false,
    serverId: SERVER_ID,
    hasSnapshot: true,
    dimmed: false,
  };

  it("never opens the previous agent while a confirmed project is being drawn", async () => {
    const { navigation, showDial } = setup();
    showDial("dial", "dev");
    const directory = new Map(AGENTS.map((record) => [record.address.agentId, record]));
    const viewOf = (): KeyView => {
      const state = navigation.slot("dev", 0);
      return slotKeyView({
        ...feed,
        slot: state.kind === "agent" ? state.address : state.kind,
        record: state.kind === "agent" ? directory.get(state.address.agentId) : undefined,
      });
    };
    let gate = deferred<undefined>();
    const renderer = new KeyRenderer(() => gate.promise);
    const press = () => {
      const state = navigation.slot("dev", 0);
      const expected = state.kind === "agent" ? state.address : null;
      return decidePress({
        rendered: renderer.renderedIdentity,
        renderedRetry: renderer.renderedRetry,
        changePending: renderer.pressChangePending,
        configured: expected,
        current: expected,
      });
    };

    const first = renderer.show(viewOf());
    gate.resolve(undefined);
    await first;
    assert.deepEqual(press(), { kind: "open", target: { serverId: SERVER_ID, agentId: "a1" } });

    navigation.rotateWorkspace("dial", 2);
    confirm(navigation, "dial");
    assert.deepEqual(press(), { kind: "refuse", reason: "not_configured" }, "not drawn yet");

    gate = deferred<undefined>();
    const second = renderer.show(viewOf());
    await flush();
    assert.deepEqual(press(), { kind: "refuse", reason: "identity_changing" }, "draw in flight");
    gate.resolve(undefined);
    await second;
    assert.deepEqual(press(), { kind: "open", target: { serverId: SERVER_ID, agentId: "b1" } });
  });
});

describe("Navigation: explicit priority refresh", () => {
  const running = (record: AgentRecord): AgentRecord => ({ ...record, status: "running" });
  const asking = (record: AgentRecord): AgentRecord => ({
    ...record,
    pendingPermissionKinds: ["question"],
  });
  const failed = (record: AgentRecord): AgentRecord => ({ ...record, status: "error" });
  const idle = Array.from({ length: 10 }, (_, index) => agent(`i${index}`, "w1"));
  const withStatus = (changes: Record<string, (record: AgentRecord) => AgentRecord>) =>
    idle.map((record) => changes[record.address.agentId]?.(record) ?? record);
  const IDLE_PAGE_1 = ["i0", "i1", "i2", "i3", "i4", "i5", "i6", "i7"];

  it("status updates never move an agent; pressing Agent pages sorts and shows page 1", () => {
    const { navigation, showDial, keys, setFacts } = setup({ agents: idle });
    showDial("dial", "dev");
    assert.deepEqual(keys(), IDLE_PAGE_1);
    navigation.rotatePages("dev", 1);

    setFacts({ agents: withStatus({ i9: running, i5: failed, i8: asking }) });
    assert.equal(navigation.pagesStrip("dev").value, "Page 2 / 2", "the page is kept");
    assert.deepEqual(keys(), ["i8", "i9", null, null, null, null, null, null], "nothing moved");

    assert.equal(navigation.pressPages("dev"), "refreshed");
    assert.equal(navigation.pagesStrip("dev").value, "Page 1 / 2");
    assert.deepEqual(keys(), ["i8", "i5", "i9", "i0", "i1", "i2", "i3", "i4"]);

    setFacts({ agents: idle });
    assert.deepEqual(keys().slice(0, 3), ["i8", "i5", "i9"], "back to idle: still no move");
  });

  it("a press on page 1 still sorts, and removes holes and agents that left", () => {
    const { navigation, showDial, keys, setFacts } = setup({ agents: idle.slice(0, 4) });
    showDial("dial", "dev", startIn("p-alpha"));
    setFacts({ agents: [agent("i1", "w2"), agent("i2", "w1"), running(agent("i3", "w1"))] });
    assert.deepEqual(keys(), [null, "i1", "i2", "i3", null, null, null, null], "hole, dimmed");
    assert.deepEqual(navigation.slot("dev", 1), {
      kind: "agent",
      address: { serverId: SERVER_ID, agentId: "i1" },
      dimmed: true,
    });

    assert.equal(navigation.pressPages("dev"), "refreshed");
    assert.deepEqual(keys(), ["i3", "i2", null, null, null, null, null, null]);
  });

  it("refuses to sort from data that is not current, but still returns to page 1", () => {
    const { navigation, showDial, keys, setFacts } = setup({ agents: idle });
    showDial("dial", "dev");
    for (const facts of [{ stale: true }, { link: "reconnecting" as const }]) {
      navigation.rotatePages("dev", 1);
      setFacts({ ...facts, agents: withStatus({ i9: running }) });
      assert.equal(navigation.pressPages("dev"), "not_current");
      assert.equal(navigation.pagesStrip("dev").value, "Page 1 / 2");
      assert.deepEqual(keys(), IDLE_PAGE_1, "no order from an old snapshot");
      setFacts({ stale: false, link: "connected", agents: idle });
    }
  });

  it("never sorts another host's layout from a fresh snapshot of a new host", () => {
    const { navigation, showDial, keys, setFacts } = setup({ agents: idle });
    showDial("dial", "dev");
    // The new host is announced, its snapshot not yet complete.
    setFacts({ serverId: OTHER_HOST, stale: true });
    assert.equal(navigation.pressPages("dev"), "not_current");
    assert.deepEqual(keys(), Array(8).fill("…"), "another host's layout is never shown");
    setFacts({ stale: false, agents: [agent("x1", null, OTHER_HOST)] });
    assert.deepEqual(keys(), ["x1", null, null, null, null, null, null, null]);
  });

  it("Project dial: pressing on the confirmed project sorts it; a preview is confirmed sorted", () => {
    const { navigation, showDial, keys, setFacts } = setup({ agents: idle });
    showDial("dial", "dev");
    navigation.rotatePages("dev", 1);
    setFacts({ agents: withStatus({ i7: running }) });
    assert.equal(confirm(navigation, "dial"), "refreshed");
    assert.equal(navigation.pagesStrip("dev").value, "Page 1 / 2");
    assert.deepEqual(keys().slice(0, 2), ["i7", "i0"]);

    setFacts({ agents: [...withStatus({ i7: running }), running(agent("b1", "w2"))] });
    navigation.rotateWorkspace("dial", 1);
    assert.equal(confirm(navigation, "dial"), "committed");
    assert.deepEqual(keys().slice(0, 2), ["i7", "i0"], "w1, freshly sorted");
  });

  it("Project dial: refreshes only when the accepted strip shows the confirmed project", () => {
    const { navigation, showDial, keys, setFacts } = setup({ agents: idle });
    showDial("dial", "dev");
    navigation.rotateWorkspace("dial", 1);
    const previewStrip = { preview: navigation.workspaceStrip("dial").preview };
    navigation.rotateWorkspace("dial", -1);
    setFacts({ agents: withStatus({ i9: running }) });
    // The strip with the preview is still on the device, or unknown.
    for (const shown of [previewStrip, null]) {
      assert.equal(navigation.pressWorkspace("dial", shown), "not_shown");
      assert.deepEqual(keys(), IDLE_PAGE_1, "neither confirmed nor sorted");
    }
    assert.equal(navigation.pressWorkspace("dial", { preview: null }), "refreshed");
    assert.equal(keys()[0], "i9");
  });

  it("refreshes only the pressed device", () => {
    const { navigation, showDial, keys, setFacts } = setup({ agents: idle });
    showDial("dial-1", "dev-1");
    showDial("dial-2", "dev-2");
    setFacts({ agents: withStatus({ i9: running }) });
    assert.equal(navigation.pressPages("dev-1"), "refreshed");
    assert.equal(keys("dev-1")[0], "i9");
    assert.deepEqual(keys("dev-2"), IDLE_PAGE_1);
  });

  it("never opens the agent that was on a key before the refresh is drawn", async () => {
    const { navigation, showDial, setFacts } = setup({ agents: idle });
    showDial("dial", "dev");
    const viewOf = (): KeyView => {
      const state = navigation.slot("dev", 0);
      const record =
        state.kind === "agent"
          ? withStatus({ i9: running }).find(
              (candidate) => candidate.address.agentId === state.address.agentId,
            )
          : undefined;
      return slotKeyView({
        connection: "ok",
        link: "connected",
        stale: false,
        failure: null,
        recoveryError: null,
        retryAvailable: false,
        serverId: SERVER_ID,
        hasSnapshot: true,
        dimmed: false,
        slot: state.kind === "agent" ? state.address : state.kind,
        record,
      });
    };
    const renderer = new KeyRenderer(() => Promise.resolve(undefined));
    await renderer.show(viewOf());
    const press = () => {
      const state = navigation.slot("dev", 0);
      const expected = state.kind === "agent" ? state.address : null;
      return decidePress({
        rendered: renderer.renderedIdentity,
        renderedRetry: renderer.renderedRetry,
        changePending: renderer.pressChangePending,
        configured: expected,
        current: expected,
      });
    };
    setFacts({ agents: withStatus({ i9: running }) });
    navigation.pressPages("dev");
    assert.deepEqual(press(), { kind: "refuse", reason: "not_configured" }, "i0 is still drawn");
    await renderer.show(viewOf());
    assert.deepEqual(press(), { kind: "open", target: { serverId: SERVER_ID, agentId: "i9" } });
  });
});

describe("Navigation: a confirmed project that disappears", () => {
  it("shows Removed for a current list and Unknown project while the list is not current", () => {
    const { navigation, showDial, keys, setFacts } = setup();
    showDial("dial", "dev", startIn("p-beta"));
    assert.equal(navigation.workspaceStrip("dial").text.value, "Beta");
    setFacts({ projects: ready(ALPHA) });
    assert.deepEqual(navigation.workspaceStrip("dial").text, {
      label: { value: "Project", color: "#a6a6ae" },
      value: "Removed",
      hint: "1 agent",
    });
    assert.deepEqual(
      keys(),
      ["b1", null, null, null, null, null, null, null],
      "the ID stays selected",
    );
    setFacts({ projects: { status: "unavailable", projects: [ALPHA], current: false } });
    assert.deepEqual(navigation.workspaceStrip("dial").text, {
      label: { value: "Project", color: "#a6a6ae" },
      value: "Unknown project",
      hint: "Projects unavailable · Retry in settings",
    });
    assert.equal(navigation.workspaceStrip("dial").preview, null);
  });
});
