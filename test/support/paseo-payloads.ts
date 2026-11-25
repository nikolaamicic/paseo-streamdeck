import { SERVER_ID } from "./fixtures.ts";

export { SERVER_ID };

/**
 * Test-only, wire-shaped payloads modeled on @getpaseo/protocol 0.15.4
 * (AgentSnapshotPayloadSchema, ProjectPlacementPayloadSchema). Synthetic data;
 * never presented as real agents.
 */
export function agentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "agent-1",
    provider: "claude",
    cwd: "/tmp/test-workspace",
    workspaceId: "workspace-1",
    model: null,
    createdAt: "2026-11-14T10:00:00.000Z",
    updatedAt: "2026-11-14T10:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {},
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "Test agent",
    labels: {},
    ...overrides,
  };
}

export function projectPayload(
  key = "project-key-1",
  name = "Test project",
): Record<string, unknown> {
  return {
    projectKey: key,
    projectName: name,
    checkout: { cwd: "/tmp/test-workspace", isGit: false },
  };
}

export function entry(
  agent: Record<string, unknown> = {},
  project: Record<string, unknown> | null = projectPayload(),
): Record<string, unknown> {
  return { agent: agentPayload(agent), project };
}

export function snapshot(entries: unknown[], hasMore = false): unknown {
  return {
    entries,
    pageInfo: { hasMore, nextCursor: hasMore ? "cursor-2" : null, prevCursor: null },
  };
}

/**
 * Test-only workspace descriptor modeled on @getpaseo/protocol 0.15.4
 * WorkspaceDescriptorPayloadSchema; includes private-looking fields so tests
 * can check that they are never copied.
 */
export function workspacePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Test project",
    projectRootPath: "/tmp/test-project",
    workspaceDirectory: "/tmp/test-project/worktree",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    title: null,
    status: "done",
    activityAt: null,
    archivingAt: null,
    scripts: [],
    ...overrides,
  };
}
