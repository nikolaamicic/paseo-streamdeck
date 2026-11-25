import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentCount,
  pagesStripText,
  workspaceStripText,
  type StripFacts,
} from "../../src/navigation/navigation-view.ts";
import type { ProjectsStatus } from "../../src/paseo/project-sync.ts";
import type { ProjectSelection } from "../../src/workspaces/project-selection.ts";
import { SERVER_ID } from "../support/fixtures.ts";

/**
 * Project strip texts (P2) for branches the Navigation tests do not reach
 * through state. Intended change from the workspace strip: the value is
 * the project name (no longer "workspace" with "Project · N agents", MR
 * !63), the count may be a lower bound, and a project list that is not
 * current is always visible. Synthetic names.
 */

const ALPHA = { address: { serverId: SERVER_ID, projectId: "p-alpha" }, name: "Project Alpha" };
const FACTS: StripFacts = {
  link: "connected",
  stale: false,
  serverId: SERVER_ID,
  projects: { status: "ready", projects: [ALPHA], current: true },
};
const alpha: ProjectSelection = { kind: "project", address: ALPHA.address };
const exact = (count: number) => ({ count, lowerBound: false });
const committed = (selection: ProjectSelection, facts: StripFacts = FACTS, members = exact(2)) =>
  workspaceStripText({ kind: "committed", committed: selection, facts, members });

describe("workspaceStripText (Project dial)", () => {
  it("a confirmed project shows its name and agent count; offline or updating wins", () => {
    assert.deepEqual(committed(alpha), {
      label: { value: "Project", color: "#a6a6ae" },
      value: "Project Alpha",
      hint: "2 agents",
    });
    assert.equal(committed(alpha, FACTS, exact(1)).hint, "1 agent");
    assert.equal(committed(alpha, FACTS, exact(0)).hint, "0 agents", "an empty project is shown");
    assert.equal(committed(alpha, { ...FACTS, link: "reconnecting" }).hint, "Offline");
    assert.equal(committed(alpha, { ...FACTS, stale: true }).hint, "Updating…");
    assert.equal(
      workspaceStripText({ kind: "committed", committed: alpha, facts: FACTS, members: null }).hint,
      "Turn to browse",
    );
  });

  it("an incomplete count is a lower bound: N+ agents", () => {
    assert.equal(committed(alpha, FACTS, { count: 3, lowerBound: true }).hint, "3+ agents");
    assert.equal(agentCount({ count: 1, lowerBound: true }), "1+ agents");
    assert.equal(
      committed({ kind: "all" }, FACTS, { count: 8, lowerBound: true }).hint,
      "8+ agents · turn to browse",
    );
  });

  it("a project list that is not current is visible on the strip", () => {
    const hints: [ProjectsStatus, string][] = [
      ["loading", "Loading projects…"],
      ["refreshing", "Updating projects…"],
      ["not_live", "Projects not live · Retry in settings"],
      ["unsynchronized", "Projects not live · Retry in settings"],
      ["unavailable", "Projects unavailable · Retry in settings"],
    ];
    for (const [status, hint] of hints) {
      const facts = { ...FACTS, projects: { status, projects: [ALPHA], current: false } };
      assert.equal(committed(alpha, facts).hint, hint, status);
      assert.equal(committed(alpha, facts).value, "Project Alpha", "the last known name stays");
    }
  });

  it("names another host's, a removed and an unknown project, never by another name", () => {
    const other: ProjectSelection = {
      kind: "project",
      address: { serverId: "srv_OtherHost02", projectId: "p-alpha" },
    };
    assert.equal(committed(other).value, "Other host");
    const gone: ProjectSelection = {
      kind: "project",
      address: { serverId: SERVER_ID, projectId: "p-gone" },
    };
    assert.equal(committed(gone).value, "Removed");
    const loading = {
      ...FACTS,
      projects: { status: "loading" as const, projects: [], current: false },
    };
    assert.equal(committed(gone, loading).value, "Unknown project");
  });

  it("an unresolved Start in says so and invites a choice", () => {
    for (const [reason, value] of [
      ["other_host", "Other host"],
      ["not_in_list", "Not in list"],
      ["removed", "Removed"],
    ] as const) {
      assert.deepEqual(committed({ kind: "unresolved", reason }, FACTS, exact(0)), {
        label: { value: "Project", color: "#a6a6ae" },
        value,
        hint: "Start in not found · turn to choose",
      });
    }
  });

  it("a preview shows the candidate's count, or why it cannot be confirmed yet", () => {
    const preview = (facts: StripFacts) =>
      workspaceStripText({ kind: "preview", preview: alpha, facts, members: exact(2) });
    assert.deepEqual(preview(FACTS), {
      label: { value: "Preview: press dial", color: "#f0b44c" },
      value: "Project Alpha",
      hint: "2 agents",
    });
    const refreshing = {
      ...FACTS,
      projects: { ...FACTS.projects, status: "refreshing" as const, current: false },
    };
    assert.deepEqual(preview(refreshing), {
      label: { value: "Preview", color: "#f0b44c" },
      value: "Project Alpha",
      hint: "Updating projects…",
    });
  });

  it("conflict names the Project dial", () => {
    assert.deepEqual(workspaceStripText({ kind: "conflict" }), {
      label: { value: "Project", color: "#a6a6ae" },
      value: "Two dials",
      hint: "Keep one Project dial",
    });
  });
});

describe("pagesStripText", () => {
  it("counts the project's agents, as a lower bound when incomplete", () => {
    const strip = (lowerBound: boolean) =>
      pagesStripText({
        kind: "pages",
        page: 0,
        pageCount: 2,
        members: { count: 9, lowerBound },
        facts: FACTS,
      });
    assert.equal(strip(false).hint, "9 agents · press: refresh");
    assert.equal(strip(true).hint, "9+ agents · press: refresh");
  });
});
