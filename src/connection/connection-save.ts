import {
  CONNECTION_KEY,
  CONNECTION_VERSION,
  isPlainObject,
  normalizeDaemonUrl,
  readSavedConnection,
  type AddressError,
  type ConnectionSource,
} from "./connection-model.ts";
import type { KnownSettings } from "./settings-reader.ts";

/**
 * What a Save of a daemon address should do (C4a1),
 * as pure functions over narrow
 * facts: the settings known now and the connection actually active. No SDK,
 * no lifecycle, no effect. The address is validated and normalized by C2
 * `normalizeDaemonUrl`; there is no second parser.
 */

/**
 * JSON as the global settings carry it. Structural, so the SDK's own
 * JsonObject accepts it without this pure model importing the SDK.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
/* A Record alias cannot refer to itself, hence the interface. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Deeper settings are not expected; the bound only keeps the check finite. */
const MAX_JSON_DEPTH = 64;

/**
 * A JSON copy of `value`, or null when any part is not JSON (a function, a
 * non-finite number, a non-plain object, deeper than MAX_JSON_DEPTH). Every
 * key is kept, also `__proto__` (Object.fromEntries defines own properties).
 */
export function toJsonObject(value: Readonly<Record<string, unknown>>): JsonObject | null {
  const copy = toJson(value, 0);
  return copy !== undefined && isJsonObject(copy) ? copy : null;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJson(value: unknown, depth: number): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (depth >= MAX_JSON_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const list: readonly unknown[] = value;
    const items: JsonValue[] = [];
    for (const item of list) {
      const copy = toJson(item, depth + 1);
      if (copy === undefined) return undefined;
      items.push(copy);
    }
    return items;
  }
  if (!isPlainObject(value)) return undefined;
  const entries: [string, JsonValue][] = [];
  for (const [key, item] of Object.entries(value)) {
    const copy = toJson(item, depth + 1);
    if (copy === undefined) return undefined;
    entries.push([key, copy]);
  }
  return Object.fromEntries(entries);
}

/** The connection a feed actually runs on (the lifecycle's active view). */
export interface ActiveConnection {
  readonly daemonUrl: string;
  readonly source: ConnectionSource;
}

/** The narrow facts a Save is decided on. */
export interface SaveFacts {
  readonly known: KnownSettings;
  readonly active: ActiveConnection | null;
}

/** A Save that writes nothing, with the reason. */
export type SaveRefusal =
  | { readonly kind: "invalid"; readonly error: AddressError }
  /** No reliable whole object was read yet: nothing to keep the other keys from. */
  | { readonly kind: "not_loaded" }
  /** The newest settings are not a plain object: nothing reliable to modify. */
  | { readonly kind: "malformed" }
  /** The known settings hold a value that is not JSON; never sent half. */
  | { readonly kind: "not_json" }
  /** The address is saved and is the active one: the one true no-op. */
  | { readonly kind: "unchanged" }
  /**
   * The address is already saved but is not active (switching, or a switch
   * blocked after an unconfirmed close): writing it again would change
   * nothing, and a Save never bypasses the lifecycle's close protection.
   */
  | { readonly kind: "saved_not_active" };

export type SaveDecision =
  | SaveRefusal
  | {
      readonly kind: "write";
      readonly daemonUrl: string;
      /** The whole object to send: the known settings with only `connection` replaced. */
      readonly settings: JsonObject;
    };

/**
 * Decides a Save of `raw` from the facts now. A reliable base is a loaded
 * whole object (`known`), whatever the latest read attempt is doing: a
 * pending, failed or timed-out read does not discard it.
 */
export function decideSave(raw: unknown, facts: SaveFacts): SaveDecision {
  const address = normalizeDaemonUrl(raw);
  if (!address.ok) return { kind: "invalid", error: address.error };
  const { known, active } = facts;
  if (known.kind === "none") return { kind: "not_loaded" };
  if (known.kind === "malformed") return { kind: "malformed" };
  const saved = readSavedConnection({ kind: "loaded", settings: known.settings });
  if (saved.kind === "ok" && saved.daemonUrl === address.daemonUrl) {
    return active?.daemonUrl === address.daemonUrl
      ? { kind: "unchanged" }
      : { kind: "saved_not_active" };
  }
  // An active legacy or default address is written too: it becomes saved.
  const settings = toJsonObject({
    ...known.settings,
    [CONNECTION_KEY]: { version: CONNECTION_VERSION, daemonUrl: address.daemonUrl },
  });
  if (settings === null) return { kind: "not_json" };
  return { kind: "write", daemonUrl: address.daemonUrl, settings };
}

/** Whether `known` now holds `daemonUrl` as its saved connection. */
export function knownSaves(known: KnownSettings, daemonUrl: string): boolean {
  if (known.kind !== "loaded") return false;
  const saved = readSavedConnection({ kind: "loaded", settings: known.settings });
  return saved.kind === "ok" && saved.daemonUrl === daemonUrl;
}
