import {
  AGENT_STATUSES,
  ATTENTION_REASONS,
  PERMISSION_KINDS,
  type AgentProject,
  type AgentRecord,
  type AgentStatus,
  type AttentionReason,
  type PermissionKind,
} from "../agents/agent-model.ts";
import { isOneOf, isRecord, isWellFormed, nonEmptyString } from "./unknown-value.ts";

/**
 * Boundary validation for agent data from the daemon. The SDK parses wire
 * messages itself, but a newer daemon may add values, so every field is read
 * defensively from `unknown`. Only what the plugin displays is kept:
 * permission request inputs and conversation content are never copied.
 */

/** Label Paseo sets on delegated agents (@getpaseo/protocol 0.15.4, agent-labels). */
const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

/** Stable validation codes; never contain payload values such as IDs. */
export type ParseErrorCode =
  | "entry_not_object"
  | "agent_not_object"
  | "missing_id"
  | "invalid_id"
  | "missing_provider"
  | "missing_status"
  | "missing_permissions"
  | "update_not_object"
  | "remove_without_agent_id"
  | "unknown_update_kind";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ParseErrorCode };

function parsePermissionKinds(value: unknown): PermissionKind[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((request: unknown) => {
    const kind = isRecord(request) ? request["kind"] : undefined;
    // An unknown kind is still a pending request; it must not disappear.
    return isOneOf(PERMISSION_KINDS, kind) ? kind : "other";
  });
}

/** Reads a directory `project` placement; anything malformed counts as unknown. */
export function parseProjectPlacement(value: unknown): AgentProject | null {
  if (!isRecord(value)) return null;
  const key = nonEmptyString(value["projectKey"]);
  const name = nonEmptyString(value["projectName"]);
  return key !== null && name !== null ? { key, name } : null;
}

/**
 * Converts an agent snapshot plus its project placement into a record.
 * `serverId` comes from the connected host, never from the agent payload.
 */
export function parseAgent(
  serverId: string,
  agent: unknown,
  project: unknown,
): ParseResult<AgentRecord> {
  if (!isRecord(agent)) return { ok: false, error: "agent_not_object" };
  const agentId = nonEmptyString(agent["id"]);
  if (agentId === null) return { ok: false, error: "missing_id" };
  if (!isWellFormed(agentId)) return { ok: false, error: "invalid_id" };
  const provider = nonEmptyString(agent["provider"]);
  if (provider === null) return { ok: false, error: "missing_provider" };
  const rawStatus = nonEmptyString(agent["status"]);
  if (rawStatus === null) return { ok: false, error: "missing_status" };
  const pendingPermissionKinds = parsePermissionKinds(agent["pendingPermissions"]);
  if (pendingPermissionKinds === null) return { ok: false, error: "missing_permissions" };
  const labels = agent["labels"];
  const workspaceId = nonEmptyString(agent["workspaceId"]);
  const attentionReason = agent["attentionReason"];

  return {
    ok: true,
    value: {
      address: { serverId, agentId },
      provider,
      title: nonEmptyString(agent["title"]),
      rawStatus,
      status: isOneOf<AgentStatus>(AGENT_STATUSES, rawStatus) ? rawStatus : "unknown",
      pendingPermissionKinds,
      requiresAttention: agent["requiresAttention"] === true,
      attentionReason: isOneOf<AttentionReason>(ATTENTION_REASONS, attentionReason)
        ? attentionReason
        : null,
      // Protocol 0.15.4: optional string; only its presence is kept.
      lastTurnFailed: nonEmptyString(agent["lastError"]) !== null,
      archivedAt: nonEmptyString(agent["archivedAt"]),
      project: parseProjectPlacement(project),
      // Protocol 0.15.4: optional string. Omitted means no placement; an empty
      // or malformed string, null or another type cannot name a workspace, so
      // the agent is treated as unplaced rather than filed under a wrong one.
      workspaceId: workspaceId !== null && isWellFormed(workspaceId) ? workspaceId : null,
      parentAgentId: isRecord(labels) ? nonEmptyString(labels[PARENT_AGENT_ID_LABEL]) : null,
      createdAt: nonEmptyString(agent["createdAt"]) ?? "",
      updatedAt: nonEmptyString(agent["updatedAt"]) ?? "",
    },
  };
}

/** Reads one `{ agent, project }` entry of a directory snapshot. */
export function parseDirectoryEntry(serverId: string, entry: unknown): ParseResult<AgentRecord> {
  if (!isRecord(entry)) return { ok: false, error: "entry_not_object" };
  return parseAgent(serverId, entry["agent"], entry["project"]);
}

export type DirectoryUpdate =
  | {
      kind: "upsert";
      record: AgentRecord;
      /**
       * False when the update omitted `project` entirely, so the previously
       * known placement still applies; an explicit `null` means "no project".
       */
      projectProvided: boolean;
    }
  | { kind: "remove"; agentId: string };

/** Reads the payload of an `agent_update` message. */
export function parseAgentUpdate(serverId: string, payload: unknown): ParseResult<DirectoryUpdate> {
  if (!isRecord(payload)) return { ok: false, error: "update_not_object" };
  const kind = payload["kind"];
  if (kind === "remove") {
    const agentId = nonEmptyString(payload["agentId"]);
    if (agentId === null) return { ok: false, error: "remove_without_agent_id" };
    if (!isWellFormed(agentId)) return { ok: false, error: "invalid_id" };
    return { ok: true, value: { kind: "remove", agentId } };
  }
  if (kind === "upsert") {
    const parsed = parseAgent(serverId, payload["agent"], payload["project"]);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      value: {
        kind: "upsert",
        record: parsed.value,
        projectProvided: payload["project"] !== undefined,
      },
    };
  }
  return { ok: false, error: "unknown_update_kind" };
}
