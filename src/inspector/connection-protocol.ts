/**
 * The connection inspector protocol v2 (C4a4a):
 * messages in both directions, their strict validators, and the pure
 * reducer a Property Inspector page uses to accept only its own session's
 * messages. Shared by the plugin (connection-inspector.ts) and, from C4b,
 * the inspector page; it imports nothing from the SDK or Node.
 *
 * Identities, each with one job:
 * - the SDK generation (plugin only): one inspector opening of a context,
 *   from didAppear to didDisappear;
 * - the challenge C: issued by the plugin once per generation;
 * - the page nonce P: chosen by one page instance;
 * - requestId: picks the latest pending Save of a bound page.
 * A generation binds at most once, to the first valid confirm of (P, C).
 * `seq` orders the messages of one binding only. None of these is a secret
 * or authentication: they correlate messages on a transport that cannot
 * recall what it already delivered.
 */

/** Every connection message, in both directions, starts with this. */
export const CONNECTION_PREFIX = "connection_";
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Page nonces and challenges: long enough not to repeat by chance. */
const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Exactly these keys, no more and no fewer. */
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** A finite, safe, positive integer. */
function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Whether a message from an inspector belongs to the connection protocol.
 * The Workspace dial checks this before its own Start in parser, so a
 * connection message, also a malformed one, never reaches Start in.
 */
export function isConnectionMessage(payload: unknown): boolean {
  if (!isPlain(payload)) return false;
  const type = payload["type"];
  return typeof type === "string" && type.startsWith(CONNECTION_PREFIX);
}

// ---------------------------------------------------------------------------
// Page → plugin
// ---------------------------------------------------------------------------

/*
 * Messages are type aliases, not interfaces, so they are valid SDK JSON
 * payloads as they are (see InspectorView in workspace-inspector.ts).
 */
/* eslint-disable @typescript-eslint/consistent-type-definitions -- see above */

export type PageMessage =
  | { readonly type: "connection_hello"; readonly pageNonce: string }
  | { readonly type: "connection_confirm"; readonly pageNonce: string; readonly challenge: string }
  | {
      readonly type: "connection_get_status";
      readonly pageNonce: string;
      readonly challenge: string;
      readonly requestId: string;
    }
  | {
      readonly type: "connection_save";
      readonly pageNonce: string;
      readonly challenge: string;
      readonly requestId: string;
      /** Unvalidated here: the Save owner validates the address (C2). */
      readonly daemonUrl: unknown;
    };

/** A valid page message, or null for anything else. */
export function parsePageMessage(payload: unknown): PageMessage | null {
  if (!isPlain(payload)) return null;
  const { type, pageNonce, challenge, requestId } = payload;
  if (!isSessionId(pageNonce)) return null;
  if (type === "connection_hello") {
    return hasKeys(payload, ["type", "pageNonce"]) ? { type, pageNonce } : null;
  }
  if (!isSessionId(challenge)) return null;
  if (type === "connection_confirm") {
    return hasKeys(payload, ["type", "pageNonce", "challenge"])
      ? { type, pageNonce, challenge }
      : null;
  }
  if (!isRequestId(requestId)) return null;
  if (type === "connection_get_status") {
    return hasKeys(payload, ["type", "pageNonce", "challenge", "requestId"])
      ? { type, pageNonce, challenge, requestId }
      : null;
  }
  if (type === "connection_save") {
    return hasKeys(payload, ["type", "pageNonce", "challenge", "requestId", "daemonUrl"])
      ? { type, pageNonce, challenge, requestId, daemonUrl: payload["daemonUrl"] }
      : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plugin → page
// ---------------------------------------------------------------------------

/*
 * The status domains, exactly the producer's (connection-model.ts,
 * link-state.ts, connection-saver.ts); connection-inspector.ts checks at
 * compile time that they cannot drift apart. A value outside them makes
 * the whole message invalid, so it is never shown or taken as success.
 */
const VIEW_KINDS = ["loading", "blocked", "switching", "switch_blocked", "active"] as const;
const SOURCES = ["saved", "legacy", "default"] as const;
const LINK_KINDS = [
  "none",
  "idle",
  "connecting",
  "connected",
  "reconnecting",
  "disconnected",
  "auth_failed",
  "closed",
] as const;
const BLOCK_REASONS = [
  "settings_unavailable",
  "settings_malformed",
  "saved_invalid",
  "legacy_unreadable",
  "legacy_malformed",
  "legacy_invalid_address",
  "legacy_invalid_target_only",
] as const;
/** The saved kinds that carry neither an address nor an error. */
const SAVED_EMPTY_KINDS = ["loading", "unavailable", "settings_malformed", "absent"] as const;
const SAVED_ERRORS = [
  "not_object",
  "unknown_field",
  "unsupported_version",
  "invalid_address",
] as const;
const SAVE_OUTCOMES = [
  "invalid",
  "not_loaded",
  "malformed",
  "not_json",
  "unchanged",
  "saved_not_active",
  "sent",
  "sent_superseded",
  "not_sent",
  "replaced",
  "stopped",
] as const;
const ADDRESS_ERRORS = [
  "not_string",
  "empty",
  "too_long",
  "forbidden_character",
  "invalid_format",
  "port_out_of_range",
] as const;

const SETTINGS_READS = ["idle", "pending", "timed_out", "failed"] as const;

export type StatusViewKind = (typeof VIEW_KINDS)[number];
export type StatusSettingsRead = (typeof SETTINGS_READS)[number];
export type StatusSource = (typeof SOURCES)[number];
export type StatusLink = (typeof LINK_KINDS)[number];
export type StatusBlockReason = (typeof BLOCK_REASONS)[number];
export type StatusSavedKind = "ok" | "invalid" | (typeof SAVED_EMPTY_KINDS)[number];
export type StatusSavedError = (typeof SAVED_ERRORS)[number];
export type SaveOutcomeKind = (typeof SAVE_OUTCOMES)[number];
export type SaveAddressError = (typeof ADDRESS_ERRORS)[number];

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((candidate) => candidate === value);
}

/** The separate connection facts as JSON for the page; codes, never raw errors. */
export type ConnectionStatusView = {
  readonly view: StatusViewKind;
  /** Only with view "blocked". */
  readonly blockedReason: StatusBlockReason | null;
  /** Only with view "active": the address a feed owner runs on; not "connected" by itself. */
  readonly active: { readonly daemonUrl: string; readonly source: StatusSource } | null;
  /** The source choice from what is known now. */
  readonly requested:
    | { readonly kind: "loading"; readonly daemonUrl: null; readonly reason: null }
    | { readonly kind: "connect"; readonly daemonUrl: string; readonly reason: null }
    | { readonly kind: "blocked"; readonly daemonUrl: null; readonly reason: StatusBlockReason };
  /** The saved connection in the known global settings. */
  readonly saved:
    | { readonly kind: "ok"; readonly daemonUrl: string; readonly error: null }
    | { readonly kind: "invalid"; readonly daemonUrl: null; readonly error: StatusSavedError }
    | {
        readonly kind: Exclude<StatusSavedKind, "ok" | "invalid">;
        readonly daemonUrl: null;
        readonly error: null;
      };
  /** Sent to Stream Deck by this plugin, never confirmed stored. */
  readonly sent: string | null;
  /** Being sent now. */
  readonly sending: string | null;
  /** The feed's own link state; "connected" only from here. */
  readonly link: StatusLink;
  /** The latest global settings read attempt; what is known stays as shown above. */
  readonly settingsRead: StatusSettingsRead;
};

export type RequestKind = "hello" | "confirm" | "get_status" | "save";
export type RejectionCode = "generation_bound" | "stale_session";

export type PluginMessage =
  /** A new generation opened; no identity: a prompt to say hello. */
  | { readonly type: "connection_ready"; readonly context: string }
  /** The answer to a hello: this generation's challenge, for that page nonce. */
  | {
      readonly type: "connection_challenge";
      readonly context: string;
      readonly pageNonce: string;
      readonly challenge: string;
    }
  | {
      readonly type: "connection_bound";
      readonly context: string;
      readonly pageNonce: string;
      readonly challenge: string;
      readonly seq: number;
      readonly status: ConnectionStatusView;
    }
  | {
      readonly type: "connection_status";
      readonly context: string;
      readonly pageNonce: string;
      readonly challenge: string;
      readonly seq: number;
      /** The status request this answers; null when the plugin pushes it. */
      readonly requestId: string | null;
      readonly status: ConnectionStatusView;
    }
  | {
      readonly type: "connection_save_result";
      readonly context: string;
      readonly pageNonce: string;
      readonly challenge: string;
      readonly seq: number;
      readonly requestId: string;
      /** The Save outcome kind; "sent" means handed to Stream Deck, never stored. */
      readonly outcome: SaveOutcomeKind;
      /** The address error code, exactly for an "invalid" outcome. */
      readonly error: SaveAddressError | null;
      readonly status: ConnectionStatusView;
    }
  /** No data: addressed to the sender's page nonce, with what it sent. */
  | {
      readonly type: "connection_rejected";
      readonly context: string;
      readonly pageNonce: string;
      /** The challenge the rejected request carried; null for a hello. */
      readonly challenge: string | null;
      readonly request: RequestKind;
      readonly requestId: string | null;
      readonly code: RejectionCode;
    };

/* eslint-enable @typescript-eslint/consistent-type-definitions */

function isRequestKind(value: unknown): value is RequestKind {
  return value === "hello" || value === "confirm" || value === "get_status" || value === "save";
}

function isRejectionCode(value: unknown): value is RejectionCode {
  return value === "generation_bound" || value === "stale_session";
}

function parsePair(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  return isPlain(value) && hasKeys(value, keys) ? value : null;
}

function parseRequested(value: unknown): ConnectionStatusView["requested"] | null {
  const pair = parsePair(value, ["kind", "daemonUrl", "reason"]);
  if (pair === null) return null;
  const { kind, daemonUrl, reason } = pair;
  if (kind === "loading" && daemonUrl === null && reason === null) {
    return { kind, daemonUrl, reason };
  }
  if (kind === "connect" && typeof daemonUrl === "string" && reason === null) {
    return { kind, daemonUrl, reason };
  }
  if (kind === "blocked" && daemonUrl === null && oneOf(BLOCK_REASONS, reason)) {
    return { kind, daemonUrl, reason };
  }
  return null;
}

function parseSaved(value: unknown): ConnectionStatusView["saved"] | null {
  const pair = parsePair(value, ["kind", "daemonUrl", "error"]);
  if (pair === null) return null;
  const { kind, daemonUrl, error } = pair;
  if (kind === "ok") {
    return typeof daemonUrl === "string" && error === null ? { kind, daemonUrl, error } : null;
  }
  if (kind === "invalid") {
    return daemonUrl === null && oneOf(SAVED_ERRORS, error) ? { kind, daemonUrl, error } : null;
  }
  if (!oneOf(SAVED_EMPTY_KINDS, kind) || daemonUrl !== null || error !== null) return null;
  return { kind, daemonUrl, error };
}

/**
 * A status view of the producer's domains and combinations only: active
 * exactly with view "active", a reason exactly with view "blocked".
 */
export function parseStatusView(value: unknown): ConnectionStatusView | null {
  const keys = [
    "view",
    "blockedReason",
    "active",
    "requested",
    "saved",
    "sent",
    "sending",
    "link",
    "settingsRead",
  ];
  if (!isPlain(value) || !hasKeys(value, keys)) return null;
  const { view, blockedReason, active, sent, sending, link, settingsRead } = value;
  if (!oneOf(VIEW_KINDS, view) || !oneOf(LINK_KINDS, link)) return null;
  if (!oneOf(SETTINGS_READS, settingsRead)) return null;
  if (!isNullableString(sent) || !isNullableString(sending)) return null;
  let activeView: ConnectionStatusView["active"] = null;
  if (view === "active") {
    const pair = parsePair(active, ["daemonUrl", "source"]);
    if (pair === null) return null;
    const { daemonUrl, source } = pair;
    if (typeof daemonUrl !== "string" || !oneOf(SOURCES, source)) return null;
    activeView = { daemonUrl, source };
  } else if (active !== null) {
    return null;
  }
  let reason: StatusBlockReason | null = null;
  if (view === "blocked") {
    if (!oneOf(BLOCK_REASONS, blockedReason)) return null;
    reason = blockedReason;
  } else if (blockedReason !== null) {
    return null;
  }
  const requested = parseRequested(value["requested"]);
  const saved = parseSaved(value["saved"]);
  if (requested === null || saved === null) return null;
  return {
    view,
    blockedReason: reason,
    active: activeView,
    requested,
    saved,
    sent,
    sending,
    link,
    settingsRead,
  };
}

/** A valid plugin message, or null for anything else. */
export function parsePluginMessage(payload: unknown): PluginMessage | null {
  if (!isPlain(payload)) return null;
  const { type, context, pageNonce, challenge, seq, requestId } = payload;
  if (typeof context !== "string" || context.length === 0) return null;
  if (type === "connection_ready") {
    return hasKeys(payload, ["type", "context"]) ? { type, context } : null;
  }
  if (!isSessionId(pageNonce)) return null;
  if (type === "connection_rejected") {
    const { request, code } = payload;
    if (
      !hasKeys(payload, [
        "type",
        "context",
        "pageNonce",
        "challenge",
        "request",
        "requestId",
        "code",
      ])
    ) {
      return null;
    }
    if (challenge !== null && !isSessionId(challenge)) return null;
    if (requestId !== null && !isRequestId(requestId)) return null;
    if (!isRequestKind(request) || !isRejectionCode(code)) return null;
    return { type, context, pageNonce, challenge, request, requestId, code };
  }
  if (!isSessionId(challenge)) return null;
  if (type === "connection_challenge") {
    return hasKeys(payload, ["type", "context", "pageNonce", "challenge"])
      ? { type, context, pageNonce, challenge }
      : null;
  }
  if (!isSeq(seq)) return null;
  const status = parseStatusView(payload["status"]);
  if (status === null) return null;
  if (type === "connection_bound") {
    return hasKeys(payload, ["type", "context", "pageNonce", "challenge", "seq", "status"])
      ? { type, context, pageNonce, challenge, seq, status }
      : null;
  }
  if (type === "connection_status") {
    if (requestId !== null && !isRequestId(requestId)) return null;
    return hasKeys(payload, [
      "type",
      "context",
      "pageNonce",
      "challenge",
      "seq",
      "requestId",
      "status",
    ])
      ? { type, context, pageNonce, challenge, seq, requestId, status }
      : null;
  }
  if (type === "connection_save_result") {
    const { outcome, error } = payload;
    const keys = [
      "type",
      "context",
      "pageNonce",
      "challenge",
      "seq",
      "requestId",
      "outcome",
      "error",
      "status",
    ];
    if (!hasKeys(payload, keys) || !isRequestId(requestId)) return null;
    if (!oneOf(SAVE_OUTCOMES, outcome)) return null;
    // An address error exactly with an "invalid" outcome.
    if (outcome === "invalid" ? !oneOf(ADDRESS_ERRORS, error) : error !== null) return null;
    const code: SaveAddressError | null =
      outcome === "invalid" && oneOf(ADDRESS_ERRORS, error) ? error : null;
    return { type, context, pageNonce, challenge, seq, requestId, outcome, error: code, status };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The page reducer
// ---------------------------------------------------------------------------

/** Why a page stopped; whether a new page nonce may try again. */
export type EndReason =
  /**
   * This generation is bound to another page nonce: only closing and
   * reopening the inspector (a new generation) can help.
   */
  | "reopen_required"
  /**
   * A new generation opened or the plugin no longer knows this binding: a
   * new page nonce may try to bind the new, unbound generation.
   */
  | "session_reset";

export type PageState =
  | { readonly kind: "awaiting"; readonly context: string; readonly pageNonce: string }
  /** The challenge is chosen before the confirm is sent; no other is ever taken. */
  | {
      readonly kind: "confirming";
      readonly context: string;
      readonly pageNonce: string;
      readonly challenge: string;
    }
  | {
      readonly kind: "bound";
      readonly context: string;
      readonly pageNonce: string;
      readonly challenge: string;
      readonly seq: number;
      readonly status: ConnectionStatusView;
      /** The latest Save sent; only its result is taken. */
      readonly pendingSave: string | null;
      /** The outcome of the latest Save that answered. */
      readonly lastSave: {
        readonly requestId: string;
        readonly outcome: SaveOutcomeKind;
        readonly error: SaveAddressError | null;
      } | null;
    }
  | { readonly kind: "ended"; readonly context: string; readonly reason: EndReason };

export interface PageStep {
  readonly state: PageState;
  /** A message the page sends now, if any. */
  readonly send: PageMessage | null;
}

const stay = (state: PageState): PageStep => ({ state, send: null });

/** A page that just loaded: awaiting, and saying hello. */
export function startPage(context: string, pageNonce: string): PageStep {
  return {
    state: { kind: "awaiting", context, pageNonce },
    send: { type: "connection_hello", pageNonce },
  };
}

/**
 * A new page nonce after a reset; only where binding can still succeed (a
 * new, unbound generation). After "reopen_required" it does nothing: the
 * page must say so instead of offering a Reconnect that cannot work.
 */
export function reconnectPage(state: PageState, pageNonce: string): PageStep {
  if (state.kind !== "ended" || state.reason !== "session_reset") return stay(state);
  return startPage(state.context, pageNonce);
}

/**
 * The page's manual "Retry" while it waits (C4b shows it in the waiting
 * state; no timer): the same hello while awaiting, the same confirm of the
 * same (P, C) while confirming. The plugin answers both idempotently, so a
 * lost challenge or bound is recovered without a new nonce, a second
 * challenge or a second binding. Anything else does nothing.
 */
export function retryHandshake(state: PageState): PageStep {
  if (state.kind === "awaiting") {
    return { state, send: { type: "connection_hello", pageNonce: state.pageNonce } };
  }
  if (state.kind === "confirming") {
    return {
      state,
      send: { type: "connection_confirm", pageNonce: state.pageNonce, challenge: state.challenge },
    };
  }
  return stay(state);
}

/** A Save from a bound page; the latest request ID is the pending one. */
export function savePage(state: PageState, requestId: string, daemonUrl: string): PageStep {
  if (state.kind !== "bound") return stay(state);
  return {
    state: { ...state, pendingSave: requestId },
    send: {
      type: "connection_save",
      pageNonce: state.pageNonce,
      challenge: state.challenge,
      requestId,
      daemonUrl,
    },
  };
}

/**
 * One message from the plugin, unvalidated. Everything that is not for
 * this page's context, nonce and (once chosen) challenge is ignored.
 */
export function receivePage(state: PageState, payload: unknown): PageStep {
  const message = parsePluginMessage(payload);
  if (message === null || state.kind === "ended" || message.context !== state.context) {
    return stay(state);
  }
  if (message.type === "connection_ready") {
    // A new generation: say hello again while awaiting; a chosen challenge
    // is dead. A stale ready can end a good binding (a needless reopen).
    if (state.kind === "awaiting")
      return { state, send: { type: "connection_hello", pageNonce: state.pageNonce } };
    return stay({ kind: "ended", context: state.context, reason: "session_reset" });
  }
  if (message.pageNonce !== state.pageNonce) return stay(state);
  if (state.kind === "awaiting") {
    if (message.type === "connection_challenge") {
      const confirming: PageState = { ...state, kind: "confirming", challenge: message.challenge };
      return {
        state: confirming,
        send: {
          type: "connection_confirm",
          pageNonce: state.pageNonce,
          challenge: message.challenge,
        },
      };
    }
    if (message.type === "connection_rejected" && message.code === "generation_bound") {
      return stay({ kind: "ended", context: state.context, reason: "reopen_required" });
    }
    return stay(state);
  }
  // From here a challenge is chosen: only messages that carry it count.
  if (message.challenge !== state.challenge) return stay(state);
  if (message.type === "connection_challenge") return stay(state);
  if (message.type === "connection_rejected") {
    return stay({
      kind: "ended",
      context: state.context,
      reason: message.code === "generation_bound" ? "reopen_required" : "session_reset",
    });
  }
  if (state.kind === "confirming") {
    if (message.type !== "connection_bound") return stay(state);
    return stay({
      kind: "bound",
      context: state.context,
      pageNonce: state.pageNonce,
      challenge: state.challenge,
      seq: message.seq,
      status: message.status,
      pendingSave: null,
      lastSave: null,
    });
  }
  if (message.seq <= state.seq) return stay(state);
  if (message.type === "connection_save_result") {
    // A result for an older Save is dropped whole: neither its seq nor its
    // status, so it cannot overwrite the newer Save's outcome.
    if (message.requestId !== state.pendingSave) return stay(state);
    return stay({
      ...state,
      seq: message.seq,
      status: message.status,
      pendingSave: null,
      lastSave: { requestId: message.requestId, outcome: message.outcome, error: message.error },
    });
  }
  return stay({ ...state, seq: message.seq, status: message.status });
}
