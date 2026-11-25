import type { AgentRecord } from "../../src/agents/agent-model.ts";
import type { WorkspaceRecord } from "../../src/workspaces/workspace-model.ts";

/** Test-only data. Never used by the runtime or presented as real agents. */
export const SERVER_ID = "srv_TestServer01";

export function makeRecord(
  overrides: Partial<AgentRecord> & { agentId?: string } = {},
): AgentRecord {
  const { agentId = "agent-1", ...rest } = overrides;
  return {
    address: { serverId: SERVER_ID, agentId },
    provider: "claude",
    title: "Test agent",
    rawStatus: "idle",
    status: "idle",
    pendingPermissionKinds: [],
    requiresAttention: false,
    attentionReason: null,
    lastTurnFailed: false,
    archivedAt: null,
    project: { key: "project-key-1", name: "Test project" },
    workspaceId: "workspace-1",
    parentAgentId: null,
    createdAt: "2026-11-14T10:00:00.000Z",
    updatedAt: "2026-11-14T10:00:00.000Z",
    ...rest,
  };
}

export function makeWorkspace(
  overrides: Partial<WorkspaceRecord> & { workspaceId?: string; serverId?: string } = {},
): WorkspaceRecord {
  const { workspaceId = "workspace-1", serverId = SERVER_ID, ...rest } = overrides;
  return {
    address: { serverId, workspaceId },
    name: "main",
    projectId: "project-1",
    projectName: "Test project",
    rawStatus: "done",
    status: "done",
    archiving: false,
    ...rest,
  };
}
