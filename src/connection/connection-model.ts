import type { AgentAddress } from "../agents/agent-model.ts";
import { isValidAgentId } from "../opener/agent-deep-link.ts";
import { DEFAULT_DAEMON_URL } from "../spike/test-agent-config.ts";

/**
 * The connection model (C2):
 * pure functions that read the saved global connection, the legacy E1 file
 * (its address and its E1 target separately) and choose the address to
 * connect to. Nothing here reads files or settings, writes anything or
 * connects; C3a wires it into the runtime. Results carry fixed codes only,
 * never the rejected input.
 */

// ---------------------------------------------------------------------------
// Daemon address
// ---------------------------------------------------------------------------

/**
 * Longest accepted input. The longest canonical address is 23 characters
 * (`ws://127.0.0.1:65535/ws`, `ws://localhost:65535/ws`); 64 leaves room
 * for letter case only, so any longer input is invalid anyway and is
 * rejected before any parsing.
 */
export const MAX_DAEMON_URL_LENGTH = 64;

/** Printable ASCII without space; everything else is rejected up front. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
/** Rejected although printable: WHATWG would silently rewrite a backslash or percent-encoding. */
const REWRITTEN_CHARACTERS = /[\\%]/;
/**
 * The only accepted shape: `ws://` + one of three loopback hosts + an
 * explicit port without leading zeros + the path. Scheme and host letters
 * may be in any case (the canonical form is lower case); the path is
 * compared exactly. Numeric aliases WHATWG would map to 127.0.0.1 (127.1,
 * 2130706433, 0x7f.0.0.1) and other loopback addresses are not accepted.
 */
const ADDRESS_SHAPE = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})(\/[^?#]*)?$/i;
const PATH = "/ws";
const MAX_PORT = 65535;

export type AddressError =
  | "not_string"
  | "empty"
  | "too_long"
  | "forbidden_character"
  | "invalid_format"
  | "port_out_of_range";

export type AddressResult =
  | { readonly ok: true; readonly daemonUrl: string }
  | { readonly ok: false; readonly error: AddressError };

/**
 * Validates a daemon address and returns its canonical form
 * `ws://<host>:<port>/ws` (host in lower case, the port exactly as given).
 * The canonical form is built from the validated parts, not from
 * `URL.href`: WHATWG drops the default port 80 of `ws:`, so `:80` would
 * otherwise look like the forbidden missing port. Canonical addresses
 * compare equal as strings, and normalizing one returns it unchanged.
 */
export function normalizeDaemonUrl(raw: unknown): AddressResult {
  if (typeof raw !== "string") return { ok: false, error: "not_string" };
  if (raw.length === 0) return { ok: false, error: "empty" };
  if (raw.length > MAX_DAEMON_URL_LENGTH) return { ok: false, error: "too_long" };
  if (!PRINTABLE_ASCII.test(raw) || REWRITTEN_CHARACTERS.test(raw)) {
    return { ok: false, error: "forbidden_character" };
  }
  const match = ADDRESS_SHAPE.exec(raw);
  const host = match?.[1]?.toLowerCase();
  const port = match?.[2];
  if (host === undefined || port === undefined || match?.[3] !== PATH) {
    return { ok: false, error: "invalid_format" };
  }
  if (Number(port) > MAX_PORT) return { ok: false, error: "port_out_of_range" };
  const daemonUrl = `ws://${host}:${port}${PATH}`;
  // Defense in depth: the platform parser must read the same parts.
  if (!platformAgrees(daemonUrl, host, port)) return { ok: false, error: "invalid_format" };
  return { ok: true, daemonUrl };
}

function platformAgrees(daemonUrl: string, host: string, port: string): boolean {
  let url: URL;
  try {
    url = new URL(daemonUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === "ws:" &&
    url.hostname === host &&
    // WHATWG reports the default port 80 of ws: as "".
    url.port === (port === "80" ? "" : port) &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === PATH &&
    url.search === "" &&
    url.hash === ""
  );
}

// ---------------------------------------------------------------------------
// Saved global connection (Stream Deck global settings)
// ---------------------------------------------------------------------------

export const CONNECTION_KEY = "connection";
export const CONNECTION_VERSION = 1;
const CONNECTION_FIELDS: readonly string[] = ["version", "daemonUrl"];

/** What reading the global settings gave: the object, or no reliable read. */
export type GlobalSettingsRead =
  { readonly kind: "loaded"; readonly settings: unknown } | { readonly kind: "unavailable" };

export type SavedConnectionError =
  "not_object" | "unknown_field" | "unsupported_version" | "invalid_address";

export type SavedConnection =
  /** No reliable read; never treated as "nothing saved". */
  | { readonly kind: "unavailable" }
  /** The global settings themselves are not a plain object. */
  | { readonly kind: "settings_malformed" }
  /** No own `connection` key. */
  | { readonly kind: "absent" }
  /** The key is present but its value is not a valid connection. */
  | { readonly kind: "invalid"; readonly error: SavedConnectionError }
  | { readonly kind: "ok"; readonly daemonUrl: string };

/** A plain JSON-like object: not null, not an array, no foreign prototype. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reads `connection` from the global settings. Other top-level keys are
 * allowed and ignored here (C4a keeps them when it writes); the connection
 * object itself is strict: exactly `version` (1) and `daemonUrl`.
 */
export function readSavedConnection(read: GlobalSettingsRead): SavedConnection {
  if (read.kind === "unavailable") return { kind: "unavailable" };
  const settings = read.settings;
  if (!isPlainObject(settings)) return { kind: "settings_malformed" };
  if (!Object.hasOwn(settings, CONNECTION_KEY)) return { kind: "absent" };
  const connection = settings[CONNECTION_KEY];
  if (!isPlainObject(connection)) return { kind: "invalid", error: "not_object" };
  if (Object.keys(connection).some((key) => !CONNECTION_FIELDS.includes(key))) {
    return { kind: "invalid", error: "unknown_field" };
  }
  if (connection["version"] !== CONNECTION_VERSION) {
    return { kind: "invalid", error: "unsupported_version" };
  }
  const address = normalizeDaemonUrl(connection["daemonUrl"]);
  if (!address.ok) return { kind: "invalid", error: "invalid_address" };
  return { kind: "ok", daemonUrl: address.daemonUrl };
}

// ---------------------------------------------------------------------------
// Legacy E1 file: its connection and its E1 target, read separately
// ---------------------------------------------------------------------------

/** Same limit the E1 loader applied before C3a3. */
export const MAX_LEGACY_BYTES = 4096;
const LEGACY_FIELDS: readonly string[] = ["serverId", "agentId", "daemonUrl"];

/** What reading the legacy file gave; the reading itself is C3a's. */
export type LegacyFileRead =
  | { readonly kind: "missing" }
  /** Not readable: permissions, not a file, an I/O error. */
  | { readonly kind: "unreadable" }
  | { readonly kind: "text"; readonly text: string };

export type LegacyConnectionError =
  "unreadable" | "malformed" | "invalid_address" | "invalid_target_only";

export type LegacyConnection =
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly error: LegacyConnectionError }
  /** `implicit`: the file has no `daemonUrl` and means the default, as today. */
  | { readonly kind: "address"; readonly daemonUrl: string; readonly implicit: boolean };

export type E1Target =
  | { readonly kind: "ok"; readonly target: AgentAddress }
  | { readonly kind: "missing" | "invalid" | "unreadable" };

export interface LegacyFile {
  readonly connection: LegacyConnection;
  readonly target: E1Target;
}

function legacyTarget(fields: Record<string, unknown>): E1Target {
  const serverId = fields["serverId"];
  const agentId = fields["agentId"];
  if (
    typeof serverId !== "string" ||
    typeof agentId !== "string" ||
    !isValidAgentId(serverId) ||
    !isValidAgentId(agentId)
  ) {
    return { kind: "invalid" };
  }
  return { kind: "ok", target: { serverId, agentId } };
}

/**
 * Interprets the legacy E1 file: a
 * target error alone does not spoil a valid explicit `daemonUrl`, and a
 * file that gives neither a valid target nor an explicit address is an
 * error, never the default.
 */
export function interpretLegacyFile(read: LegacyFileRead): LegacyFile {
  if (read.kind === "missing") {
    return { connection: { kind: "absent" }, target: { kind: "missing" } };
  }
  if (read.kind === "unreadable") {
    return {
      connection: { kind: "error", error: "unreadable" },
      target: { kind: "unreadable" },
    };
  }
  const malformed: LegacyFile = {
    connection: { kind: "error", error: "malformed" },
    target: { kind: "invalid" },
  };
  if (new TextEncoder().encode(read.text).byteLength > MAX_LEGACY_BYTES) return malformed;
  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch {
    return malformed;
  }
  if (!isPlainObject(value)) return malformed;
  if (Object.keys(value).some((key) => !LEGACY_FIELDS.includes(key))) return malformed;

  const target = legacyTarget(value);
  if (Object.hasOwn(value, "daemonUrl")) {
    const address = normalizeDaemonUrl(value["daemonUrl"]);
    return {
      connection: address.ok
        ? { kind: "address", daemonUrl: address.daemonUrl, implicit: false }
        : { kind: "error", error: "invalid_address" },
      target,
    };
  }
  return {
    connection:
      target.kind === "ok"
        ? { kind: "address", daemonUrl: DEFAULT_DAEMON_URL, implicit: true }
        : { kind: "error", error: "invalid_target_only" },
    target,
  };
}

// ---------------------------------------------------------------------------
// Choosing the connection
// ---------------------------------------------------------------------------

export type ConnectionSource = "saved" | "legacy" | "default";

export type ConnectionBlock =
  | "settings_unavailable"
  | "settings_malformed"
  | "saved_invalid"
  | `legacy_${LegacyConnectionError}`;

/**
 * What every view shows about the connection (C3a3): still choosing the
 * source, connected through a chosen address, blocked because the global
 * settings could not be read (Retry reads again), blocked by a source that
 * is not valid, or blocked because the previous connection's close was not
 * confirmed during an address change (C3b2; restart the plugin).
 */
export type ConnectionState = "loading" | "ok" | "unavailable" | "invalid" | "switch_blocked";

export type ConnectionChoice =
  | { readonly kind: "connect"; readonly daemonUrl: string; readonly source: ConnectionSource }
  | { readonly kind: "blocked"; readonly reason: ConnectionBlock };

/**
 * saved > legacy > default. An invalid
 * or unreadable source blocks instead of falling through: the default is
 * used only when nothing is saved and no legacy file exists.
 */
export function chooseConnection(
  saved: SavedConnection,
  legacy: LegacyConnection,
): ConnectionChoice {
  switch (saved.kind) {
    case "unavailable":
      return { kind: "blocked", reason: "settings_unavailable" };
    case "settings_malformed":
      return { kind: "blocked", reason: "settings_malformed" };
    case "invalid":
      return { kind: "blocked", reason: "saved_invalid" };
    case "ok":
      return { kind: "connect", daemonUrl: saved.daemonUrl, source: "saved" };
    case "absent":
      break;
  }
  switch (legacy.kind) {
    case "address":
      return { kind: "connect", daemonUrl: legacy.daemonUrl, source: "legacy" };
    case "error":
      return { kind: "blocked", reason: `legacy_${legacy.error}` };
    case "absent":
      return { kind: "connect", daemonUrl: DEFAULT_DAEMON_URL, source: "default" };
  }
}
