import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectRecord } from "../../src/workspaces/project-model.ts";
import {
  ALL_PROJECTS,
  ProjectChoice,
  choiceSourceOf,
  resolveStartIn,
  selectProject,
  selectionKey,
  selectionList,
  stepSelection,
  type ChoiceFacts,
} from "../../src/workspaces/project-selection.ts";
import { readStartIn, type StartIn } from "../../src/workspaces/start-in-settings.ts";
import { makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

/**
 * The Project dial's selection (P2): All or one project by host and project
 * ID; a saved Start in that cannot be resolved stays visibly unresolved.
 * Synthetic names only.
 */

const OTHER_HOST = "srv_OtherHost02";
const project = (projectId: string, name: string, serverId = SERVER_ID): ProjectRecord => ({
  address: { serverId, projectId },
  name,
});
const ALPHA = project("p-alpha", "Alpha");
const BETA = project("p-beta", "Beta");
const GAMMA = project("p-gamma", "Gamma");
const WORKSPACES = [
  makeWorkspace({ workspaceId: "a-main", projectId: "p-alpha" }),
  makeWorkspace({ workspaceId: "a-feature", projectId: "p-alpha" }),
  makeWorkspace({ workspaceId: "b-main", projectId: "p-beta" }),
];

const facts = (overrides: Partial<ChoiceFacts> = {}): ChoiceFacts => ({
  ready: true,
  stale: false,
  serverId: SERVER_ID,
  workspaces: WORKSPACES,
  truncated: false,
  ...overrides,
});
const startIn = (settings: unknown): StartIn => readStartIn(settings).startIn;
const v1 = (workspaceId: string, serverId = SERVER_ID) =>
  startIn({ version: 1, startIn: { serverId, workspaceId } });
const v2 = (projectId: string, serverId = SERVER_ID) =>
  startIn({ version: 2, startIn: { serverId, projectId } });

describe("the Project dial list", () => {
  it("puts All first, then the host's projects by name and ID; same names stay apart", () => {
    const twin = project("p-alpha-2", "Alpha");
    const list = selectionList(
      [GAMMA, twin, project("p-x", "X", OTHER_HOST), BETA, ALPHA],
      SERVER_ID,
    );
    assert.deepEqual(list.map(selectionKey), [
      "all",
      selectionKey(selectProject(ALPHA.address)),
      selectionKey(selectProject(twin.address)),
      selectionKey(selectProject(BETA.address)),
      selectionKey(selectProject(GAMMA.address)),
    ]);
  });

  it("moves by ticks, wraps, and moves a removed or unresolved selection from All", () => {
    const list = selectionList([ALPHA, BETA], SERVER_ID);
    assert.equal(stepSelection(list, ALL_PROJECTS, -1), list[2]);
    assert.equal(stepSelection(list, list[2] ?? ALL_PROJECTS, 1), ALL_PROJECTS);
    const removed = selectProject({ serverId: SERVER_ID, projectId: "p-gone" });
    assert.equal(stepSelection(list, removed, 1), list[1]);
    assert.equal(stepSelection(list, removed, 0), removed);
    const unresolved = resolveStartIn(v1("w-gone"), {
      ...choiceSourceOf(facts()),
      serverId: SERVER_ID,
    });
    assert.equal(stepSelection(list, unresolved, 1), list[1]);
  });
});

describe("resolveStartIn", () => {
  const context = { ...choiceSourceOf(facts()), serverId: SERVER_ID };

  it("All stays All; a version 2 project is selected by ID on its host", () => {
    assert.equal(resolveStartIn(startIn({}), context), ALL_PROJECTS);
    assert.equal(resolveStartIn(startIn({ version: 1, startIn: null }), context), ALL_PROJECTS);
    assert.deepEqual(resolveStartIn(v2("p-beta"), context), selectProject(BETA.address));
  });

  it("a version 1 workspace resolves only through the current host's workspace → project link", () => {
    assert.deepEqual(resolveStartIn(v1("a-feature"), context), selectProject(ALPHA.address));
    assert.deepEqual(resolveStartIn(v1("b-main"), context), selectProject(BETA.address));
  });

  it("another host, a removed or an unlisted workspace stays visibly unresolved, never All", () => {
    assert.deepEqual(resolveStartIn(v1("a-main", OTHER_HOST), context), {
      kind: "unresolved",
      reason: "other_host",
    });
    assert.deepEqual(resolveStartIn(v2("p-alpha", OTHER_HOST), context), {
      kind: "unresolved",
      reason: "other_host",
    });
    assert.deepEqual(resolveStartIn(v1("w-gone"), context), {
      kind: "unresolved",
      reason: "removed",
    });
    assert.deepEqual(resolveStartIn(v1("w-gone"), { ...context, workspacesTruncated: true }), {
      kind: "unresolved",
      reason: "not_in_list",
    });
  });
});

describe("ProjectChoice", () => {
  it("stays unresolved until the feed is ready and fresh, and ignores choices meanwhile", () => {
    const choice = new ProjectChoice(v2("p-alpha"));
    assert.equal(choice.sync(choiceSourceOf(facts({ ready: false }))), false);
    assert.equal(choice.choose(ALL_PROJECTS), false);
    assert.equal(choice.sync(choiceSourceOf(facts({ stale: true }))), false);
    assert.equal(choice.selection, null);
    assert.equal(choice.sync(choiceSourceOf(facts())), true);
    assert.deepEqual(choice.selection, selectProject(ALPHA.address));
  });

  it("an unresolved version 1 Start in resolves late when its workspace appears", () => {
    const choice = new ProjectChoice(v1("a-late"));
    choice.sync(choiceSourceOf(facts({ truncated: true })));
    assert.deepEqual(choice.selection, { kind: "unresolved", reason: "not_in_list" });
    const late = [...WORKSPACES, makeWorkspace({ workspaceId: "a-late", projectId: "p-beta" })];
    assert.equal(choice.sync(choiceSourceOf(facts({ workspaces: late }))), true);
    assert.deepEqual(choice.selection, selectProject(BETA.address));
  });

  it("a late automatic resolution never replaces a project the user confirmed", () => {
    const choice = new ProjectChoice(v1("a-late"));
    choice.sync(choiceSourceOf(facts({ truncated: true })));
    assert.equal(choice.choose(selectProject(GAMMA.address)), true);
    const late = [...WORKSPACES, makeWorkspace({ workspaceId: "a-late", projectId: "p-beta" })];
    assert.equal(choice.sync(choiceSourceOf(facts({ workspaces: late }))), false);
    assert.deepEqual(choice.selection, selectProject(GAMMA.address));
  });

  it("keeps a user choice for the same host, refuses another host's project, resolves again for a new host", () => {
    const choice = new ProjectChoice(v2("p-alpha"));
    choice.sync(choiceSourceOf(facts()));
    assert.equal(choice.choose(selectProject({ serverId: OTHER_HOST, projectId: "p-x" })), false);
    assert.equal(choice.choose(selectProject(BETA.address)), true);
    assert.equal(choice.sync(choiceSourceOf(facts())), false, "same host: kept");
    assert.equal(choice.sync(choiceSourceOf(facts({ serverId: OTHER_HOST, stale: true }))), true);
    assert.equal(choice.selection, null, "a new host is loading");
    choice.sync(choiceSourceOf(facts({ serverId: OTHER_HOST })));
    assert.deepEqual(choice.selection, { kind: "unresolved", reason: "other_host" });
  });

  it("keeps a removed project's ID selected: no silent switch to All", () => {
    const choice = new ProjectChoice(v2("p-gone"));
    choice.sync(choiceSourceOf(facts()));
    assert.deepEqual(choice.selection, selectProject({ serverId: SERVER_ID, projectId: "p-gone" }));
  });
});
