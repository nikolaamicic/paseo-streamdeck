import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRecord } from "../../src/agents/agent-model.ts";
import { Navigation, type NavigationFacts } from "../../src/navigation/navigation.ts";
import type { ProjectsState, ProjectsStatus } from "../../src/paseo/project-sync.ts";
import type { ProjectRecord } from "../../src/workspaces/project-model.ts";
import { startInSettings } from "../../src/workspaces/start-in-settings.ts";
import { WorkspaceDialContexts } from "../../src/workspaces/workspace-dial-contexts.ts";
import { makeRecord, makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

/**
 * The Project dial over the real Navigation (P2): a project's agents come
 * from all its workspaces (agent workspaceId → workspace projectId), names
 * only from the project list, and a new project is confirmed only while
 * that list is current. Synthetic names: Alpha has two workspaces, Beta
 * one, Gamma none.
 */

const OTHER_HOST = "srv_OtherHost02";
const project = (projectId: string, name: string, serverId = SERVER_ID): ProjectRecord => ({
  address: { serverId, projectId },
  name,
});
const ALPHA = project("p-alpha", "Alpha");
const BETA = project("p-beta", "Beta");
const GAMMA = project("p-gamma", "Gamma");
const projects = (
  list: ProjectRecord[] = [ALPHA, BETA, GAMMA],
  status: ProjectsStatus = "ready",
): ProjectsState => ({ status, projects: list, current: status === "ready" });

const agent = (agentId: string, workspaceId: string | null, serverId = SERVER_ID): AgentRecord => ({
  ...makeRecord({ agentId, workspaceId }),
  address: { serverId, agentId },
});

const WORKSPACES = [
  makeWorkspace({ workspaceId: "a-main", projectId: "p-alpha", name: "main" }),
  makeWorkspace({ workspaceId: "a-feature", projectId: "p-alpha", name: "feature" }),
  makeWorkspace({ workspaceId: "b-main", projectId: "p-beta", name: "main" }),
];
const AGENTS = [
  agent("a1", "a-main"),
  agent("a2", "a-feature"),
  agent("a3", "a-feature"),
  agent("b1", "b-main"),
  agent("loose", null),
];

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
    projects: projects(),
    ...overrides,
  };
  const contexts = new WorkspaceDialContexts();
  const navigation = new Navigation(contexts, () => facts);
  const showDial = (settings: unknown = {}) => {
    contexts.appear("dial", settings);
    navigation.workspaceDialShown("dial", "dev");
    navigation.sync();
  };
  const keys = () =>
    Array.from({ length: 8 }, (_, slot) => {
      const state = navigation.slot("dev", slot);
      return state.kind === "agent" ? state.address.agentId : state.kind === "empty" ? null : "…";
    });
  const shown = () => keys().filter((key) => key !== null);
  const setFacts = (next: Partial<NavigationFacts>) => {
    facts = { ...facts, ...next };
    navigation.sync();
  };
  const confirm = () =>
    navigation.pressWorkspace("dial", { preview: navigation.workspaceStrip("dial").preview });
  /** Turns from the confirmed selection to `name` (one step at a time) and confirms it. */
  const choose = (name: string) => {
    for (let step = 0; step < 10; step += 1) {
      if (navigation.workspaceStrip("dial").text.value === name) break;
      navigation.rotateWorkspace("dial", 1);
    }
    return confirm();
  };
  const strip = () => navigation.workspaceStrip("dial").text;
  return { navigation, contexts, showDial, keys, shown, setFacts, confirm, choose, strip };
}

describe("Project dial: agents of all the project's workspaces", () => {
  it("Alpha shows the agents of both its workspaces, Beta its one, empty Gamma 0", () => {
    const { showDial, shown, choose, strip, navigation } = setup();
    showDial();
    assert.deepEqual(shown(), ["a1", "a2", "a3", "b1", "loose"], "All projects: every agent");
    assert.equal(choose("Alpha"), "committed");
    assert.deepEqual(shown(), ["a1", "a2", "a3"]);
    assert.equal(strip().hint, "3 agents");
    assert.equal(choose("Beta"), "committed");
    assert.deepEqual(shown(), ["b1"]);
    assert.equal(choose("Gamma"), "committed", "an empty project is listed and can be chosen");
    assert.deepEqual(shown(), []);
    assert.deepEqual(strip(), {
      label: { value: "Project", color: "#a6a6ae" },
      value: "Gamma",
      hint: "0 agents",
    });
    assert.equal(navigation.pagesStrip("dev").hint, "0 agents · press: refresh");
  });

  it("turns over All and the projects by name; two projects of one name stay apart by ID", () => {
    const twin = project("p-alpha-2", "Alpha");
    const { navigation, showDial, shown, confirm } = setup({
      projects: projects([ALPHA, twin, BETA]),
      workspaces: [...WORKSPACES, makeWorkspace({ workspaceId: "t-main", projectId: "p-alpha-2" })],
      agents: [...AGENTS, agent("t1", "t-main")],
    });
    showDial();
    const seen: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      navigation.rotateWorkspace("dial", 1);
      seen.push(navigation.workspaceStrip("dial").text.value);
    }
    assert.deepEqual(seen, ["Alpha", "Alpha", "Beta", "All projects"]);
    navigation.rotateWorkspace("dial", 2);
    assert.equal(confirm(), "committed");
    assert.deepEqual(shown(), ["t1"], "the second Alpha by ID, never merged by name");
  });

  it("more than eight agents of one project page by eight; confirming a project returns to page 1", () => {
    const many = Array.from({ length: 11 }, (_, index) =>
      agent(`m${String(index).padStart(2, "0")}`, index % 2 === 0 ? "a-main" : "a-feature"),
    );
    const { navigation, showDial, keys, choose } = setup({
      agents: [...many, agent("b1", "b-main")],
    });
    showDial(startInSettings({ serverId: SERVER_ID, projectId: "p-alpha" }));
    assert.equal(navigation.pagesStrip("dev").value, "Page 1 / 2");
    assert.equal(navigation.rotatePages("dev", 1), "moved");
    assert.deepEqual(keys().slice(0, 3), ["m08", "m09", "m10"]);
    assert.equal(choose("Beta"), "committed");
    assert.equal(navigation.pagesStrip("dev").value, "Page 1 / 1");
    navigation.rotateWorkspace("dial", -1);
    assert.equal(navigation.workspaceStrip("dial").text.value, "Alpha");
    navigation.pressWorkspace("dial", { preview: navigation.workspaceStrip("dial").preview });
    assert.equal(navigation.pagesStrip("dev").value, "Page 1 / 2", "page 1 again");
  });
});

describe("Project dial: identity and host isolation", () => {
  it("never counts another host's agents or lists another host's project of the same ID", () => {
    const { navigation, showDial, shown, choose } = setup({
      agents: [...AGENTS, agent("x1", "a-main", OTHER_HOST)],
      projects: projects([ALPHA, BETA, project("p-alpha", "Alpha elsewhere", OTHER_HOST)]),
    });
    showDial();
    assert.equal(choose("Alpha"), "committed");
    assert.deepEqual(shown(), ["a1", "a2", "a3"]);
    for (let step = 0; step < 3; step += 1) {
      navigation.rotateWorkspace("dial", 1);
      assert.notEqual(navigation.workspaceStrip("dial").text.value, "Alpha elsewhere");
    }
  });

  it("follows a rename, a removal and new membership without moving keys by themselves", () => {
    const { showDial, keys, shown, setFacts, strip, navigation } = setup();
    showDial(startInSettings({ serverId: SERVER_ID, projectId: "p-alpha" }));
    setFacts({ projects: projects([{ ...ALPHA, name: "Alpha renamed" }, BETA, GAMMA]) });
    assert.equal(strip().value, "Alpha renamed", "the name comes from the list");
    assert.deepEqual(shown(), ["a1", "a2", "a3"], "membership is by ID: unchanged");

    // b-main moves to Alpha: its agent joins at the end; a1 leaves (dimmed in place).
    setFacts({
      workspaces: [
        ...WORKSPACES.slice(0, 2),
        makeWorkspace({ workspaceId: "b-main", projectId: "p-alpha" }),
      ],
      agents: [agent("a1", "x-gone"), ...AGENTS.slice(1)],
    });
    assert.deepEqual(keys().slice(0, 4), ["a1", "a2", "a3", "b1"]);
    const first = navigation.slot("dev", 0);
    assert.equal(first.kind === "agent" && first.dimmed, true, "a1 left the project");
    assert.equal(strip().hint, "3 agents", "a dimmed agent is not counted");

    setFacts({ projects: projects([BETA, GAMMA]) });
    assert.equal(strip().value, "Removed");
    assert.equal(navigation.pressPages("dev"), "refreshed");
    assert.deepEqual(shown(), ["a2", "a3", "b1"], "the ID stays selected; no silent All");
  });

  it("counts are a lower bound (N+) when the lists are truncated and an agent may belong", () => {
    const { showDial, setFacts, strip, navigation } = setup({
      agents: [...AGENTS, agent("u1", "w-unlisted")],
    });
    showDial(startInSettings({ serverId: SERVER_ID, projectId: "p-alpha" }));
    assert.equal(strip().hint, "3 agents", "a complete workspace list: u1 belongs to none");
    setFacts({ truncated: true });
    assert.equal(strip().hint, "3+ agents");
    assert.equal(navigation.pagesStrip("dev").hint, "3+ agents · press: refresh");
    setFacts({ truncated: false, agentsTruncated: true });
    assert.equal(strip().hint, "3+ agents");
  });
});

describe("Project dial: a project list that is not current", () => {
  for (const status of [
    "loading",
    "refreshing",
    "not_live",
    "unsynchronized",
    "unavailable",
  ] as const) {
    it(`${status}: no new project is previewed or confirmed; the confirmed one still refreshes`, () => {
      const { navigation, showDial, shown, setFacts, confirm, strip } = setup();
      showDial(startInSettings({ serverId: SERVER_ID, projectId: "p-beta" }));
      navigation.rotateWorkspace("dial", -1);
      assert.equal(strip().value, "Alpha");
      setFacts({ projects: projects([ALPHA, BETA, GAMMA], status) });
      assert.equal(confirm(), "not_current", "the preview is kept but not confirmed");
      assert.equal(navigation.rotateWorkspace("dial", 1), "not_current");
      assert.deepEqual(shown(), ["b1"]);
      assert.notEqual(strip().hint, "3 agents", "the strip says why");
      setFacts({ projects: projects([ALPHA, BETA, GAMMA]) });
      assert.equal(confirm(), "committed", "current again (after Retry): the preview confirms");
      assert.deepEqual(shown(), ["a1", "a2", "a3"]);
      setFacts({ projects: projects([ALPHA, BETA, GAMMA], status) });
      assert.equal(confirm(), "refreshed", "no preview: the confirmed project refreshes");
    });
  }
});

describe("Project dial: Start in", () => {
  const legacy = (workspaceId: string, serverId = SERVER_ID) => ({
    version: 1,
    startIn: { serverId, workspaceId },
  });

  it("a version 1 workspace starts in its project, with the agents of all its workspaces", () => {
    const { showDial, shown, strip } = setup();
    showDial(legacy("a-feature"));
    assert.equal(strip().value, "Alpha");
    assert.deepEqual(shown(), ["a1", "a2", "a3"]);
  });

  it("a missing, unlisted or other-host workspace is visibly unresolved: no keys, never All", () => {
    for (const [settings, overrides, value] of [
      [legacy("w-gone"), {}, "Removed"],
      [legacy("w-gone"), { truncated: true }, "Not in list"],
      [legacy("a-main", OTHER_HOST), {}, "Other host"],
    ] as const) {
      const { showDial, keys, strip } = setup(overrides);
      showDial(settings);
      assert.deepEqual(keys(), Array(8).fill(null), value);
      assert.deepEqual(strip(), {
        label: { value: "Project", color: "#a6a6ae" },
        value,
        hint: "Start in not found · turn to choose",
      });
    }
  });

  it("a late resolution follows Start in, but never replaces the user's confirmed choice", () => {
    const appears = [...WORKSPACES, makeWorkspace({ workspaceId: "w-late", projectId: "p-beta" })];
    const late = setup({ truncated: true });
    late.showDial(legacy("w-late"));
    assert.equal(late.strip().value, "Not in list");
    late.setFacts({ workspaces: appears });
    assert.equal(late.strip().value, "Beta", "resolved once its workspace is listed");
    assert.deepEqual(late.shown(), ["b1"]);

    const manual = setup({ truncated: true });
    manual.showDial(legacy("w-late"));
    assert.equal(manual.choose("Gamma"), "committed");
    manual.setFacts({ workspaces: appears });
    assert.equal(manual.strip().value, "Gamma", "the confirmed choice stays");
  });
});
