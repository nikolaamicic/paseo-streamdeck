import { isRecord, isWellFormed, nonEmptyString } from "../paseo/unknown-value.ts";
import type { ProjectAddress } from "./project-model.ts";
import type { WorkspaceAddress } from "./workspace-model.ts";

/**
 * Start in, stored in the action settings of each Project dial (the owner,
 * 2026-11-16: every Stream Deck profile can have its own starting point).
 * @elgato/streamdeck 3.0.4 has no API for the active profile; per-profile
 * values come from each placed dial being its own action instance with its
 * own settings. Action settings are plain text and part of exported
 * profiles, so only IDs are stored: no names, paths or secrets.
 *
 * Version 2 (P2, written): { "version": 2, "startIn": { "serverId", "projectId" } | null }.
 * Version 1 (W6, read only): { "version": 1, "startIn": { "serverId", "workspaceId" } | null }.
 * startIn null means All projects in both. A version 1 workspace is never
 * rewritten automatically; it is resolved to its project at runtime
 * (project-selection.ts) and replaced only by an explicit inspector choice.
 */
export const START_IN_SETTINGS_VERSION = 2;
const LEGACY_SETTINGS_VERSION = 1;

/** Upper bound for a stored ID; real IDs are far shorter. */
const MAX_ID_LENGTH = 256;
/** Unknown settings are kept on a write only up to this nesting depth. */
const MAX_KEPT_DEPTH = 8;

/** The saved starting point of one dial. */
export type StartIn =
  | { readonly kind: "all" }
  | { readonly kind: "project"; readonly address: ProjectAddress }
  /** A version 1 setting: a workspace, resolved to its project on the current host only. */
  | { readonly kind: "legacy_workspace"; readonly address: WorkspaceAddress };

export const START_IN_ALL: StartIn = Object.freeze({ kind: "all" });

/** Stable codes for settings that could not be used; never contain values. */
export type StartInSettingsIssue =
  "settings_not_object" | "unsupported_version" | "invalid_start_in";

export interface StartInRead {
  /** The starting point; All when the settings are empty or unusable. */
  readonly startIn: StartIn;
  /** Why the settings were not used; null when they were valid or empty. */
  readonly issue: StartInSettingsIssue | null;
}

function readId(value: unknown): string | null {
  const id = nonEmptyString(value);
  return id !== null && id.length <= MAX_ID_LENGTH && isWellFormed(id) ? id : null;
}

const unusable = (issue: StartInSettingsIssue): StartInRead => ({ startIn: START_IN_ALL, issue });

/**
 * Reads a dial's action settings. Empty settings (a newly placed dial) mean
 * All without an issue. Anything unusable also means All, with a stable
 * code; the stored settings are left as they are, never rewritten here.
 * Unknown extra fields are ignored.
 */
export function readStartIn(settings: unknown): StartInRead {
  if (!isRecord(settings)) return unusable("settings_not_object");
  if (Object.keys(settings).length === 0) return { startIn: START_IN_ALL, issue: null };
  const version = settings["version"];
  if (version !== START_IN_SETTINGS_VERSION && version !== LEGACY_SETTINGS_VERSION) {
    return unusable("unsupported_version");
  }
  const startIn = settings["startIn"];
  if (startIn === null || startIn === undefined) return { startIn: START_IN_ALL, issue: null };
  if (!isRecord(startIn)) return unusable("invalid_start_in");
  const serverId = readId(startIn["serverId"]);
  if (version === LEGACY_SETTINGS_VERSION) {
    const workspaceId = readId(startIn["workspaceId"]);
    if (serverId === null || workspaceId === null) return unusable("invalid_start_in");
    return {
      startIn: Object.freeze({
        kind: "legacy_workspace",
        address: Object.freeze({ serverId, workspaceId }),
      }),
      issue: null,
    };
  }
  const projectId = readId(startIn["projectId"]);
  if (serverId === null || projectId === null) return unusable("invalid_start_in");
  return {
    startIn: Object.freeze({ kind: "project", address: Object.freeze({ serverId, projectId }) }),
    issue: null,
  };
}

export function sameStartIn(a: StartIn, b: StartIn): boolean {
  if (a.kind === "all" || b.kind === "all") return a.kind === b.kind;
  if (a.kind === "project" && b.kind === "project") {
    return a.address.serverId === b.address.serverId && a.address.projectId === b.address.projectId;
  }
  if (a.kind === "legacy_workspace" && b.kind === "legacy_workspace") {
    return (
      a.address.serverId === b.address.serverId && a.address.workspaceId === b.address.workspaceId
    );
  }
  return false;
}

/**
 * A JSON value as the SDK's settings constraint (JsonObject) accepts it;
 * mutable like the SDK's own type, which a readonly array does not satisfy.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isJsonValue(value: unknown, depth: number): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= MAX_KEPT_DEPTH) return false;
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
  return isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
}

/**
 * The stored settings. A type alias, not an interface: only object type
 * aliases get the implicit index signature the SDK's settings constraint
 * (JsonObject) requires, so setSettings accepts it
 * (test/workspaces/settings-compat.ts checks this at compile time).
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see above
export type StartInSettings = {
  readonly [key: string]: JsonValue;
  readonly version: typeof START_IN_SETTINGS_VERSION;
  readonly startIn: { readonly serverId: string; readonly projectId: string } | null;
};

/**
 * The settings to store for an explicit Start in choice (the inspector
 * only; dial rotation never writes settings). Fields of `previous` the
 * plugin does not know are kept, so a newer or other writer's data
 * survives; only `version` and `startIn` are replaced. A field that is not
 * plain JSON (or nested too deep) cannot be stored and is left out.
 */
export function startInSettings(
  startIn: ProjectAddress | null,
  previous: unknown = {},
): StartInSettings {
  // Object.fromEntries defines data properties, so an own "__proto__" key
  // (valid JSON) is kept as data; an assignment would call the prototype
  // setter instead and lose it.
  const kept: Record<string, JsonValue> = isRecord(previous)
    ? Object.fromEntries(
        Object.entries(previous).filter(
          (entry): entry is [string, JsonValue] =>
            entry[0] !== "version" && entry[0] !== "startIn" && isJsonValue(entry[1], 0),
        ),
      )
    : {};
  return {
    ...kept,
    version: START_IN_SETTINGS_VERSION,
    startIn: startIn === null ? null : { serverId: startIn.serverId, projectId: startIn.projectId },
  };
}
