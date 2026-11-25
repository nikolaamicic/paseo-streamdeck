import {
  WORKSPACE_STATUSES,
  type WorkspaceRecord,
  type WorkspaceStatus,
} from "../workspaces/workspace-model.ts";
import { isOneOf, isRecord, isWellFormed, nonEmptyString } from "./unknown-value.ts";

/**
 * Boundary validation for workspace data from the daemon
 * (@getpaseo/protocol 0.15.4 WorkspaceDescriptorPayloadSchema and
 * workspace_update). The client SDK does not validate directory messages, so
 * every field is read from `unknown`. Directories, project root paths,
 * scripts and git data are never copied.
 */

/** Stable validation codes; never contain payload values such as IDs or paths. */
export type WorkspaceParseErrorCode =
  | "workspace_not_object"
  | "missing_workspace_id"
  | "invalid_workspace_id"
  | "missing_workspace_name"
  | "missing_project_id"
  | "missing_project_name"
  | "missing_workspace_status"
  | "workspace_update_not_object"
  | "remove_without_workspace_id"
  | "unknown_workspace_update_kind";

export type WorkspaceParseResult<T> =
  { ok: true; value: T } | { ok: false; error: WorkspaceParseErrorCode };

/**
 * Converts one workspace descriptor into a record. `serverId` comes from the
 * connected host. Names are kept as received (the protocol allows any
 * string); labels are cleaned when drawn.
 */
export function parseWorkspace(
  serverId: string,
  workspace: unknown,
): WorkspaceParseResult<WorkspaceRecord> {
  if (!isRecord(workspace)) return { ok: false, error: "workspace_not_object" };
  const workspaceId = nonEmptyString(workspace["id"]);
  if (workspaceId === null) return { ok: false, error: "missing_workspace_id" };
  if (!isWellFormed(workspaceId)) return { ok: false, error: "invalid_workspace_id" };
  const name = workspace["name"];
  if (typeof name !== "string") return { ok: false, error: "missing_workspace_name" };
  const projectId = nonEmptyString(workspace["projectId"]);
  if (projectId === null || !isWellFormed(projectId)) {
    return { ok: false, error: "missing_project_id" };
  }
  const projectName = workspace["projectDisplayName"];
  if (typeof projectName !== "string") return { ok: false, error: "missing_project_name" };
  const rawStatus = nonEmptyString(workspace["status"]);
  if (rawStatus === null) return { ok: false, error: "missing_workspace_status" };

  return {
    ok: true,
    value: {
      address: { serverId, workspaceId },
      name,
      projectId,
      projectName,
      rawStatus,
      status: isOneOf<WorkspaceStatus>(WORKSPACE_STATUSES, rawStatus) ? rawStatus : "unknown",
      // Any non-empty string counts, as in the schema; the timestamp format is
      // not checked. Omitted, null or another type means not archiving.
      archiving: nonEmptyString(workspace["archivingAt"]) !== null,
    },
  };
}

export type WorkspaceUpdate =
  { kind: "upsert"; record: WorkspaceRecord } | { kind: "remove"; workspaceId: string };

/** Reads the payload of a `workspace_update` message. */
export function parseWorkspaceUpdate(
  serverId: string,
  payload: unknown,
): WorkspaceParseResult<WorkspaceUpdate> {
  if (!isRecord(payload)) return { ok: false, error: "workspace_update_not_object" };
  const kind = payload["kind"];
  if (kind === "remove") {
    const workspaceId = nonEmptyString(payload["id"]);
    if (workspaceId === null) return { ok: false, error: "remove_without_workspace_id" };
    if (!isWellFormed(workspaceId)) return { ok: false, error: "invalid_workspace_id" };
    return { ok: true, value: { kind: "remove", workspaceId } };
  }
  if (kind === "upsert") {
    const parsed = parseWorkspace(serverId, payload["workspace"]);
    return parsed.ok ? { ok: true, value: { kind: "upsert", record: parsed.value } } : parsed;
  }
  return { ok: false, error: "unknown_workspace_update_kind" };
}
