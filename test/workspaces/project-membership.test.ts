import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentsInScope,
  countInScope,
  type MembershipFacts,
  type ProjectScope,
} from "../../src/workspaces/project-membership.ts";
import { makeRecord, makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

/**
 * Agent → project membership (P1) only through the agent's workspaceId and
 * that workspace's projectId. Synthetic data: Project Alpha with A1 and A2,
 * Project Beta with B1, an empty Project Gamma, and two projects with the
 * same name.
 */

const WORKSPACES = [
  makeWorkspace({
    workspaceId: "a1",
    projectId: "p-alpha",
    projectName: "Project Alpha",
    name: "A1",
  }),
  makeWorkspace({
    workspaceId: "a2",
    projectId: "p-alpha",
    projectName: "Project Alpha",
    name: "A2",
  }),
  makeWorkspace({
    workspaceId: "b1",
    projectId: "p-beta",
    projectName: "Project Beta",
    name: "B1",
  }),
  makeWorkspace({ workspaceId: "s1", projectId: "p-same-1", projectName: "Same", name: "S1" }),
  makeWorkspace({ workspaceId: "s2", projectId: "p-same-2", projectName: "Same", name: "S2" }),
];
const AGENTS = [
  makeRecord({ agentId: "x1", workspaceId: "a1", title: "Plan task one" }),
  makeRecord({ agentId: "x2", workspaceId: "a2" }),
  makeRecord({ agentId: "x3", workspaceId: "b1" }),
  makeRecord({ agentId: "x4", workspaceId: null }),
  makeRecord({ agentId: "x5", workspaceId: "s1" }),
  makeRecord({ agentId: "x6", workspaceId: "s2" }),
];
const FACTS: MembershipFacts = {
  serverId: SERVER_ID,
  workspaces: WORKSPACES,
  workspacesTruncated: false,
  agentsTruncated: false,
};
const project = (projectId: string, serverId = SERVER_ID): ProjectScope => ({
  kind: "project",
  address: { serverId, projectId },
});
const ids = (scope: ProjectScope, facts = FACTS, agents = AGENTS) =>
  agentsInScope(agents, scope, facts).map((agent) => agent.address.agentId);

describe("project membership", () => {
  it("a project has the agents of all its workspaces; an empty project has none", () => {
    assert.deepEqual(ids(project("p-alpha")), ["x1", "x2"]);
    assert.deepEqual(ids(project("p-beta")), ["x3"]);
    assert.deepEqual(ids(project("p-gamma")), []);
    assert.deepEqual(countInScope(AGENTS, project("p-alpha"), FACTS), {
      count: 2,
      lowerBound: false,
    });
  });

  it("projects with the same name stay apart; another host has none", () => {
    assert.deepEqual(ids(project("p-same-1")), ["x5"]);
    assert.deepEqual(ids(project("p-same-2")), ["x6"]);
    assert.deepEqual(ids(project("p-alpha", "srv_OtherHost02")), []);
  });

  it("an agent without a known workspace counts only for All projects", () => {
    const unknown = [...AGENTS, makeRecord({ agentId: "x7", workspaceId: "gone" })];
    assert.deepEqual(ids({ kind: "all" }, FACTS, unknown), [
      "x1",
      "x2",
      "x3",
      "x4",
      "x5",
      "x6",
      "x7",
    ]);
    assert.deepEqual(ids(project("p-alpha"), FACTS, unknown), ["x1", "x2"]);
  });

  it("counts are a lower bound only where a truncated list may hide members", () => {
    const unknown = [...AGENTS, makeRecord({ agentId: "x7", workspaceId: "gone" })];
    const truncatedWorkspaces = { ...FACTS, workspacesTruncated: true };
    assert.deepEqual(countInScope(unknown, project("p-alpha"), truncatedWorkspaces), {
      count: 2,
      lowerBound: true,
    });
    assert.deepEqual(
      countInScope(AGENTS, project("p-alpha"), truncatedWorkspaces),
      {
        count: 2,
        lowerBound: false,
      },
      "every agent's workspace is known: nothing can be missing",
    );
    assert.deepEqual(countInScope(unknown, { kind: "all" }, truncatedWorkspaces), {
      count: 7,
      lowerBound: false,
    });
    const truncatedAgents = { ...FACTS, agentsTruncated: true };
    assert.equal(countInScope(AGENTS, { kind: "all" }, truncatedAgents).lowerBound, true);
    assert.equal(countInScope(AGENTS, project("p-beta"), truncatedAgents).lowerBound, true);
  });
});
