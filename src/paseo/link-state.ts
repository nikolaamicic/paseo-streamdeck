import type { ConnectionState } from "@getpaseo/client";

/**
 * Connection state as the plugin presents it, derived from the documented
 * `getConnectionState()` of @getpaseo/client 0.15.4. The SDK reconnects on its
 * own; "disconnected" means the daemon has not been reached yet,
 * "reconnecting" that a live connection was lost.
 *
 * The SDK's free-text `reason` is never exposed: it may contain URLs,
 * credentials or paths. It is only compared, exactly, against the
 * authentication messages of client 0.15.4 (an auth failure disables
 * reconnecting and reports one of them).
 */
export interface LinkState {
  readonly kind:
    | "idle"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "disconnected"
    | "auth_failed"
    | "closed";
}

const AUTH_FAILURE_MESSAGES: readonly string[] = ["Password required", "Incorrect password"];

export function toLinkState(state: ConnectionState, hasConnectedBefore: boolean): LinkState {
  switch (state.status) {
    case "idle":
      return { kind: "idle" };
    case "connecting":
      if (hasConnectedBefore) return { kind: "reconnecting" };
      // Later attempts while the daemon was never reached stay "disconnected"
      // so the display does not flicker on every SDK retry.
      return state.attempt > 0 ? { kind: "disconnected" } : { kind: "connecting" };
    case "connected":
      return { kind: "connected" };
    case "disconnected":
      if (state.reason !== undefined && AUTH_FAILURE_MESSAGES.includes(state.reason)) {
        return { kind: "auth_failed" };
      }
      return hasConnectedBefore ? { kind: "reconnecting" } : { kind: "disconnected" };
    case "disposed":
      return { kind: "closed" };
  }
}

export function sameLinkState(a: LinkState, b: LinkState): boolean {
  return a.kind === b.kind;
}
