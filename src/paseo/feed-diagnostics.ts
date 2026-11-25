import type { ParseErrorCode } from "./agent-parser.ts";
import type { WorkspaceParseErrorCode } from "./workspace-parser.ts";

/**
 * Diagnostics the feed exposes to its consumers. They contain only stable
 * codes and fixed text: raw SDK/transport error messages, connection
 * reasons, payload values and IDs are never copied, because they may carry
 * credentials, private paths or control characters.
 */

export type AgentFeedErrorCode =
  | "closed"
  | "already_started"
  | "connect_failed"
  | "auth_failed"
  | "host_identity_failed"
  | "subscribe_failed"
  | "start_timeout"
  | "subscription_failed"
  | "initial_snapshot_invalid"
  | "cleanup_failed";

const ERROR_MESSAGES: Readonly<Record<AgentFeedErrorCode, string>> = {
  closed: "the agent feed was closed",
  already_started: "the agent feed was already started",
  connect_failed: "could not connect to the Paseo daemon",
  auth_failed: "the Paseo daemon rejected the authentication",
  host_identity_failed: "the Paseo daemon did not report a usable server identity",
  subscribe_failed: "could not subscribe to a Paseo directory (agents or workspaces)",
  start_timeout: "the Paseo daemon did not finish starting the feed in time",
  subscription_failed: "a Paseo directory subscription failed",
  initial_snapshot_invalid: "the first snapshot of a Paseo directory was invalid",
  cleanup_failed: "closing the agent feed did not complete cleanly",
};

/** Feed errors carry a stable code and a fixed message, never the underlying cause. */
export class AgentFeedError extends Error {
  readonly code: AgentFeedErrorCode;

  constructor(code: AgentFeedErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AgentFeedError";
    this.code = code;
  }
}

export type FeedWarningCode =
  | "snapshot_invalid"
  | "entry_skipped"
  | "update_ignored"
  | "page_truncated"
  | "workspace_snapshot_invalid"
  | "workspace_entry_skipped"
  | "workspace_update_ignored"
  | "workspace_page_truncated"
  | "server_changed"
  | "resync_failed"
  | "project_list_failed"
  | "project_list_invalid"
  | "project_entry_skipped"
  | "project_update_ignored"
  | "project_subscription_failed"
  | "project_release_failed"
  | "project_sync_missing"
  | "project_sync_failed"
  | "listener_failed"
  | "internal_error";

const WARNING_MESSAGES: Readonly<Record<FeedWarningCode, string>> = {
  snapshot_invalid: "an agent directory snapshot had an unexpected shape and was ignored",
  entry_skipped: "an agent directory entry was invalid and was skipped",
  update_ignored: "an invalid agent update was ignored",
  page_truncated: "the daemon has more agents than one page; only the first page is observed",
  workspace_snapshot_invalid:
    "a workspace directory snapshot had an unexpected shape and was ignored",
  workspace_entry_skipped: "a workspace directory entry was invalid and was skipped",
  workspace_update_ignored: "an invalid workspace update was ignored",
  workspace_page_truncated:
    "the daemon has more workspaces than one page; only the first page is observed",
  server_changed: "the daemon server identity changed after reconnect; the directories are rebuilt",
  resync_failed: "a directory snapshot could not be applied; data stays marked stale",
  project_list_failed: "the project list could not be read; projects are not available",
  project_list_invalid: "the project list had an unexpected shape and was ignored",
  project_entry_skipped: "a project entry was invalid and was skipped",
  project_update_ignored: "an invalid project update was ignored",
  project_subscription_failed:
    "project updates could not be subscribed; the project list is not kept current",
  project_release_failed: "a project update subscription could not be released cleanly",
  project_sync_missing:
    "the daemon sent no project sync position; the project list is not kept current",
  project_sync_failed: "the project list could not be brought in sync; projects are not available",
  listener_failed: "a feed listener threw an error",
  internal_error: "an internal feed operation failed",
};

/** Which validation rule rejected the input, for skipped entries and ignored updates. */
export type WarningDetail = ParseErrorCode | WorkspaceParseErrorCode;

export interface FeedWarning {
  readonly code: FeedWarningCode;
  readonly message: string;
  readonly detail?: WarningDetail;
}

export function feedWarning(code: FeedWarningCode, detail?: WarningDetail): FeedWarning {
  return detail === undefined
    ? { code, message: WARNING_MESSAGES[code] }
    : { code, message: WARNING_MESSAGES[code], detail };
}
