import type { ProjectRecord } from "../workspaces/project-model.ts";
import { isRecord, isWellFormed, nonEmptyString } from "./unknown-value.ts";

/**
 * Boundary validation of project data (P1) from @getpaseo/protocol 0.15.4:
 * `project.list.response` (WorkspaceProjectDescriptorPayloadSchema entries
 * and optional DirectorySyncMetadata) and the `project.update` event. Root
 * paths, keys and icons are never copied. Every field is read from `unknown`.
 */

/** Where the list sits in the daemon's project directory. */
export interface ProjectSync {
  readonly generation: string;
  /** The newest change the snapshot includes. */
  readonly headSeq: number;
}

export interface ProjectList {
  readonly projects: readonly ProjectRecord[];
  readonly skipped: number;
  /** Null when the daemon sent no sync metadata: updates cannot be ordered. */
  readonly sync: ProjectSync | null;
}

export type ProjectUpdate =
  | {
      readonly kind: "upsert";
      readonly project: ProjectRecord;
      readonly position: ProjectSync | null;
    }
  | { readonly kind: "remove"; readonly projectId: string; readonly position: ProjectSync | null };

function readId(value: unknown): string | null {
  const id = nonEmptyString(value);
  return id !== null && isWellFormed(id) ? id : null;
}

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** One project descriptor; null when it has no usable ID or name. */
export function parseProject(serverId: string, value: unknown): ProjectRecord | null {
  if (!isRecord(value)) return null;
  const projectId = readId(value["projectId"]);
  const name = value["projectDisplayName"];
  if (projectId === null || typeof name !== "string") return null;
  return Object.freeze({ address: Object.freeze({ serverId, projectId }), name });
}

/**
 * The list response payload; null when it is not a complete list. The
 * plugin asks without a cursor, so the daemon answers with a full
 * "snapshot"; a "changes" answer holds only changed projects and is never
 * taken for the whole list.
 */
export function parseProjectList(serverId: string, payload: unknown): ProjectList | null {
  if (!isRecord(payload) || !Array.isArray(payload["projects"])) return null;
  const sync = payload["sync"];
  if (isRecord(sync) && sync["mode"] !== undefined && sync["mode"] !== "snapshot") return null;
  const entries: readonly unknown[] = payload["projects"];
  const projects: ProjectRecord[] = [];
  for (const entry of entries) {
    const project = parseProject(serverId, entry);
    if (project !== null) projects.push(project);
  }
  let position: ProjectSync | null = null;
  if (isRecord(sync)) {
    const generation = nonEmptyString(sync["generation"]);
    const headSeq = sync["headSeq"];
    if (generation !== null && isSeq(headSeq)) position = { generation, headSeq };
  }
  return { projects, skipped: entries.length - projects.length, sync: position };
}

/** A `project.update` payload; null when malformed. */
export function parseProjectUpdate(serverId: string, payload: unknown): ProjectUpdate | null {
  if (!isRecord(payload)) return null;
  const generation = nonEmptyString(payload["generation"]);
  const seq = payload["seq"];
  const position = generation !== null && isSeq(seq) ? { generation, headSeq: seq } : null;
  if (payload["kind"] === "upsert") {
    const project = parseProject(serverId, payload["project"]);
    return project === null ? null : { kind: "upsert", project, position };
  }
  if (payload["kind"] === "remove") {
    const projectId = readId(payload["projectId"]);
    return projectId === null ? null : { kind: "remove", projectId, position };
  }
  return null;
}
