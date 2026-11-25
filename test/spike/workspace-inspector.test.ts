import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectsStatus } from "../../src/paseo/project-sync.ts";
import {
  ALL_VALUE,
  inspectorView,
  parseInspectorRequest,
  resolveInspectorChoice,
  type InspectorFacts,
} from "../../src/spike/workspace-inspector.ts";
import { projectKey, type ProjectRecord } from "../../src/workspaces/project-model.ts";
import { readStartIn, START_IN_ALL, type StartIn } from "../../src/workspaces/start-in-settings.ts";
import { makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

/**
 * The Project dial's inspector view model (P2). Adapted from the workspace
 * inspector (intended semantics): the list holds the host's projects from
 * the project list, Start in is saved as a project (version 2), a version 1
 * workspace is shown as its project until the user chooses, and Retry is
 * offered for the project list states that need it. Synthetic names.
 */

const at = (projectId: string, serverId = SERVER_ID) => ({ serverId, projectId });
const record = (projectId: string, name: string, serverId = SERVER_ID): ProjectRecord => ({
  address: at(projectId, serverId),
  name,
});
const project = (projectId: string, serverId = SERVER_ID): StartIn => ({
  kind: "project",
  address: at(projectId, serverId),
});
const legacy = (workspaceId: string, serverId = SERVER_ID): StartIn =>
  readStartIn({ version: 1, startIn: { serverId, workspaceId } }).startIn;

function facts(overrides: Partial<InspectorFacts> = {}): InspectorFacts {
  return {
    connection: "ok",
    failure: null,
    ready: true,
    stale: false,
    link: "connected",
    serverId: SERVER_ID,
    workspaces: [
      makeWorkspace({ workspaceId: "w1", projectId: "p-alpha" }),
      makeWorkspace({ workspaceId: "w2", projectId: "p-beta" }),
    ],
    truncated: false,
    projects: {
      status: "ready",
      projects: [record("p-beta", "Beta"), record("p-alpha", "Alpha"), record("p-gamma", "Gamma")],
      current: true,
    },
    ...overrides,
  };
}
const withStatus = (status: ProjectsStatus, projects = facts().projects.projects) =>
  facts({ projects: { status, projects, current: status === "ready" } });

describe("inspectorView (Project dial)", () => {
  it("lists All projects first, then the host's projects by name, with the saved project selected", () => {
    const view = inspectorView("ctx", project("p-beta"), facts());
    assert.deepEqual(
      view.options.map((option) => option.label),
      ["All projects", "Alpha", "Beta", "Gamma"],
      "the empty Gamma is listed too",
    );
    assert.equal(view.selected, projectKey(at("p-beta")));
    assert.deepEqual([view.canChoose, view.canRetry, view.notice], [true, false, null]);
    assert.equal(inspectorView("ctx", START_IN_ALL, facts()).selected, ALL_VALUE);
  });

  it("tells apart projects of the same name by a number, never merges them; another host's are not listed", () => {
    const view = inspectorView(
      "ctx",
      START_IN_ALL,
      facts({
        projects: {
          status: "ready",
          projects: [
            record("p-2", "Alpha"),
            record("p-1", "Alpha"),
            record("p-x", "Other", "srv_Other"),
          ],
          current: true,
        },
      }),
    );
    assert.deepEqual(
      view.options.slice(1).map((option) => [option.label, option.value]),
      [
        ["Alpha (1)", projectKey(at("p-1"))],
        ["Alpha (2)", projectKey(at("p-2"))],
      ],
    );
  });

  it("keeps an unavailable saved project selected as a disabled entry instead of switching", () => {
    const removed = inspectorView("ctx", project("p-gone"), facts());
    assert.deepEqual(
      removed.options.find((option) => option.value === removed.selected),
      { value: "saved", label: "Saved project (no longer available)", disabled: true },
    );
    const otherHost = inspectorView("ctx", project("p-alpha", "srv_Other"), facts());
    assert.equal(
      otherHost.options.find((option) => option.value === otherHost.selected)?.label,
      "Saved project (on another Paseo host)",
    );
  });

  it("a version 1 workspace shows its project with a notice; unresolved it stays a disabled entry", () => {
    const resolved = inspectorView("ctx", legacy("w2"), facts());
    assert.equal(resolved.selected, projectKey(at("p-beta")));
    assert.equal(
      resolved.notice,
      "Saved by an earlier version as a workspace. Choose a project to save it as a project.",
    );
    for (const [startIn, overrides, label] of [
      [legacy("gone"), {}, "Saved workspace (no longer available)"],
      [legacy("gone"), { truncated: true }, "Saved workspace (not in the shown list)"],
      [legacy("w1", "srv_Other"), {}, "Saved workspace (on another Paseo host)"],
    ] as const) {
      const view = inspectorView("ctx", startIn, facts(overrides));
      assert.equal(view.selected, "saved", label);
      assert.equal(view.options.find((option) => option.value === "saved")?.label, label);
    }
  });

  it("explains every state and only allows a choice from current agents and a current project list", () => {
    const cases: [InspectorFacts, string][] = [
      [facts({ connection: "loading" }), "Loading the Paseo connection…"],
      [facts({ failure: "start_timeout" }), "Cannot reach Paseo. Use Retry on the agent key."],
      [facts({ ready: false }), "Loading projects…"],
      [facts({ link: "reconnecting" }), "Offline. Showing the last known projects."],
      [facts({ stale: true }), "Updating the agent list…"],
      [withStatus("loading"), "Loading projects…"],
      [withStatus("refreshing"), "Updating the project list…"],
      [withStatus("unavailable"), "The project list is not available. Use Retry projects."],
      [withStatus("not_live"), "The project list is not kept current. Use Retry projects."],
      [
        withStatus("unsynchronized"),
        "Paseo sent no project list position; the list is not kept current. Use Retry projects.",
      ],
    ];
    for (const [input, status] of cases) {
      const view = inspectorView("ctx", START_IN_ALL, input);
      assert.equal(view.status, status);
      assert.equal(view.canChoose, false, status);
    }
    const empty = inspectorView("ctx", START_IN_ALL, withStatus("ready", []));
    assert.equal(empty.status, "No projects found in Paseo.");
    assert.deepEqual(
      empty.options.map((option) => option.label),
      ["All projects"],
    );
  });

  it("offers Retry projects only for the states that need it and only with a working feed", () => {
    const retry = (input: InspectorFacts) => inspectorView("ctx", START_IN_ALL, input).canRetry;
    assert.deepEqual(
      (
        ["ready", "loading", "refreshing", "not_live", "unsynchronized", "unavailable"] as const
      ).map((status) => retry(withStatus(status))),
      [false, false, false, true, true, true],
    );
    const unavailable = withStatus("unavailable");
    assert.equal(retry({ ...unavailable, connection: "loading" }), false);
    assert.equal(retry({ ...unavailable, failure: "start_timeout" }), false);
    assert.equal(retry({ ...unavailable, ready: false }), false);
  });

  it("carries daemon names only as label text, never private paths", () => {
    const view = inspectorView(
      "ctx",
      START_IN_ALL,
      withStatus("ready", [record("p1", "<b>x</b> & q")]),
    );
    assert.equal(view.options[1]?.label, "<b>x</b> & q", "rendered as text by the page");
    assert.doesNotMatch(JSON.stringify(view), /\/tmp\/|\/Users\//);
  });
});

describe("parseInspectorRequest", () => {
  it("accepts refresh, retry_projects and choose, and nothing else", () => {
    assert.deepEqual(parseInspectorRequest({ type: "refresh" }), { kind: "refresh" });
    assert.deepEqual(parseInspectorRequest({ type: "retry_projects" }), { kind: "retry_projects" });
    assert.deepEqual(parseInspectorRequest({ type: "choose", value: "all" }), {
      kind: "choose",
      value: "all",
    });
    for (const payload of [
      null,
      "refresh",
      [],
      { type: "choose" },
      { type: "choose", value: 7 },
      { type: "choose", value: "x".repeat(2000) },
      { type: "delete" },
    ]) {
      assert.equal(parseInspectorRequest(payload), null, JSON.stringify(payload));
    }
  });
});

describe("resolveInspectorChoice", () => {
  it("accepts All and listed projects of the connected host, also an empty one", () => {
    assert.deepEqual(resolveInspectorChoice(ALL_VALUE, facts()), { ok: true, startIn: null });
    assert.deepEqual(resolveInspectorChoice(projectKey(at("p-gamma")), facts()), {
      ok: true,
      startIn: at("p-gamma"),
    });
  });

  it("refuses choices from an outdated agent or project list, or for projects not listed on this host", () => {
    for (const input of [
      facts({ stale: true }),
      facts({ link: "reconnecting" }),
      facts({ ready: false }),
      facts({ failure: "subscription_failed" }),
      facts({ connection: "switch_blocked" }),
      withStatus("refreshing"),
      withStatus("not_live"),
      withStatus("unavailable"),
    ]) {
      assert.deepEqual(resolveInspectorChoice(ALL_VALUE, input), {
        ok: false,
        reason: "not_current",
      });
    }
    for (const value of [
      projectKey(at("p-gone")),
      projectKey(at("p-alpha", "srv_Other")),
      "saved",
    ]) {
      assert.deepEqual(resolveInspectorChoice(value, facts()), {
        ok: false,
        reason: "unknown_project",
      });
    }
  });
});
