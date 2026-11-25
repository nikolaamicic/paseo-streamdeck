import {
  receivePage,
  reconnectPage,
  retryHandshake,
  savePage,
  startPage,
  type ConnectionStatusView,
  type PageMessage,
  type PageState,
  type PageStep,
  type SaveAddressError,
  type SaveOutcomeKind,
  type StatusBlockReason,
} from "../connection-protocol.ts";

/**
 * The "Paseo connection" section of every action's Property Inspector
 * (C4b), without the DOM: it drives the
 * shared protocol reducer (connection-protocol.ts) and turns its state into
 * text and enabled controls. The DOM glue (connection-dom.ts) and tests give
 * it a view, a transport and an ID source.
 *
 * Only an explicit Save sends connection_save, only while bound and with no
 * Save waiting for its answer; once that answer is unknown (no answer in
 * 5 s, or the session or socket ended first), a new explicit Save is
 * allowed again. The address is not parsed here: the plugin validates it
 * (C2). Texts never claim more than the plugin reported: "sent" is not
 * "stored", and "connected" comes only from the feed's link.
 */

/** What the page shows; the DOM glue maps it to elements. */
export interface PageView {
  setStatus(text: string): void;
  /** Extra lines, only where they help; an empty list shows nothing. */
  setDetails(lines: readonly string[]): void;
  setMessage(text: string): void;
  /** Which recovery control is offered, if any. */
  setRecovery(kind: "none" | "retry" | "reconnect"): void;
  setInput(value: string): void;
  setSaveEnabled(enabled: boolean): void;
}

export interface PageTransport {
  /** Hands a message to Stream Deck; false when the socket is not open. */
  send(message: PageMessage): boolean;
}

export interface PageDeps {
  readonly context: string;
  readonly view: PageView;
  readonly transport: PageTransport;
  /** A new page nonce (16–64 of [A-Za-z0-9_-]), from crypto.getRandomValues. */
  readonly newNonce: () => string;
  /** One-shot timer for the Save answer bound. */
  readonly after: (delayMs: number, callback: () => void) => { cancel(): void };
}

/**
 * How long the page waits for a Save's answer before it says the outcome is
 * unknown, as the Workspace inspector does (5 s). The request is not
 * cancelled and not repeated; a late, matching answer still counts.
 */
export const SAVE_ANSWER_TIMEOUT_MS = 5_000;

const ADDRESS_ERROR_TEXT: Readonly<Record<SaveAddressError, string>> = {
  not_string: "Enter a daemon address.",
  empty: "Enter a daemon address.",
  too_long: "The address is too long.",
  forbidden_character: "The address contains characters that are not allowed.",
  invalid_format: "Use a local address such as ws://127.0.0.1:6767/ws.",
  port_out_of_range: "The port must be between 1 and 65535.",
};

const BLOCK_TEXT: Readonly<Record<StatusBlockReason, string>> = {
  settings_unavailable:
    "Plugin settings could not be read. Close and reopen this inspector to read them again.",
  settings_malformed: "The plugin settings are not valid.",
  saved_invalid: "The saved Paseo address is not valid. Save a valid address.",
  legacy_unreadable: "The configuration file of an earlier test build could not be read.",
  legacy_malformed: "The configuration file of an earlier test build is not valid.",
  legacy_invalid_address:
    "The address in the configuration file of an earlier test build is not valid.",
  legacy_invalid_target_only:
    "The configuration file of an earlier test build has neither a valid address nor a valid agent.",
};

/** The status line: what the plugin reports, never more. */
export function statusText(status: ConnectionStatusView): string {
  switch (status.view) {
    case "loading":
      return "Loading the Paseo connection…";
    case "blocked":
      return status.blockedReason === null
        ? "The Paseo connection is blocked."
        : BLOCK_TEXT[status.blockedReason];
    case "switching":
      return "Switching the Paseo connection…";
    case "switch_blocked":
      return "Could not confirm the previous connection closed. Restart the plugin.";
    case "active":
      return activeText(status);
  }
}

function activeText(status: ConnectionStatusView): string {
  const url = status.active?.daemonUrl ?? "";
  switch (status.link) {
    case "connected":
      return `Connected to Paseo at ${url}.`;
    case "none":
    case "idle":
    case "connecting":
      return `Connecting to ${url}…`;
    case "reconnecting":
    case "disconnected":
      return `Offline. Reconnecting to ${url}…`;
    case "auth_failed":
      return "Password protected daemon is not supported.";
    case "closed":
      return `The connection to ${url} is closed.`;
  }
}

/** Extra lines: a saved address that is not the one in use, a send, a read. */
export function detailLines(status: ConnectionStatusView): string[] {
  const lines: string[] = [];
  const active = status.active?.daemonUrl ?? null;
  if (status.saved.kind === "ok" && status.saved.daemonUrl !== active) {
    lines.push(`Saved address: ${status.saved.daemonUrl} (not in use).`);
  }
  if (status.sending !== null) lines.push(`Sending to Stream Deck: ${status.sending}…`);
  if (status.settingsRead === "pending") lines.push("Reading plugin settings…");
  const readBlocked = status.view === "blocked" && status.blockedReason === "settings_unavailable";
  // The status line already says it when the read is what blocks.
  if (!readBlocked && (status.settingsRead === "timed_out" || status.settingsRead === "failed")) {
    const known = status.saved.kind !== "loading" && status.saved.kind !== "unavailable";
    lines.push(
      known
        ? "Plugin settings could not be read again; showing the last known. Reopen this inspector to retry."
        : "Plugin settings could not be read. Close and reopen this inspector to retry.",
    );
  }
  return lines;
}

/** The message after a Save's own answer. */
export function outcomeText(outcome: SaveOutcomeKind, error: SaveAddressError | null): string {
  switch (outcome) {
    case "sent":
      return "Sent to Stream Deck.";
    case "sent_superseded":
      return "Sent, but a newer setting arrived meanwhile; it is shown above.";
    case "not_sent":
      return "The request was not sent to Stream Deck.";
    case "invalid":
      return error === null ? "The address is not valid." : ADDRESS_ERROR_TEXT[error];
    case "not_loaded":
      return "Plugin settings are not loaded yet; nothing was sent.";
    case "malformed":
      return "The plugin settings are not valid; nothing was sent.";
    case "not_json":
      return "The plugin settings hold data that cannot be kept; nothing was sent.";
    case "unchanged":
      return "This address is already saved and in use.";
    case "saved_not_active":
      return "This address is already saved but not in use; see the status above.";
    case "replaced":
      return "A newer Save replaced this one before it was sent.";
    case "stopped":
      return "The plugin is stopping; this Save may not have finished.";
  }
}

const WAITING = "Waiting for the plugin…";
const NO_ANSWER =
  "No answer from the plugin; the outcome of this Save is unknown. Reopen this inspector to see the current state.";
const NOT_CONNECTED = "Not connected to Stream Deck; the request was not sent.";
const DISCONNECTED = "Disconnected from Stream Deck. Close and reopen this inspector.";
const SESSION_ENDED_UNKNOWN =
  "The inspector session was reset before this Save's answer; its outcome is unknown. Check the status once connected again.";
const CLOSED_UNKNOWN =
  "Disconnected before this Save's answer; its outcome is unknown. Close and reopen this inspector to see the current state.";

/** A Save the page is waiting for, with the input's edit revision at that moment. */
interface WaitingSave {
  readonly requestId: string;
  readonly editRevision: number;
  readonly timer: { cancel(): void };
  /** Its answer did not come in time; a late matching one still counts. */
  unknown: boolean;
}

export class ConnectionPage {
  private readonly deps: PageDeps;
  private state: PageState;
  private input = "";
  /** Rises with every user edit, also one that types back the same text. */
  private editRevision = 0;
  /** The user edited since the input was last filled by the page. */
  private dirty = false;
  private filled = false;
  private waiting: WaitingSave | null = null;
  private requests = 0;
  private closed = false;

  constructor(deps: PageDeps) {
    this.deps = deps;
    this.state = { kind: "awaiting", context: deps.context, pageNonce: deps.newNonce() };
  }

  /** The socket is open: say hello. */
  start(): void {
    const step = startPage(this.deps.context, this.nonceOf(this.state));
    this.apply(step);
  }

  /** A message from the plugin, unvalidated. */
  receive(payload: unknown): void {
    if (this.closed) return;
    this.apply(receivePage(this.state, payload));
  }

  /** The user edited the address. */
  inputChanged(value: string): void {
    this.input = value;
    this.editRevision += 1;
    this.dirty = true;
  }

  /** The explicit Save; does nothing unless allowed now. */
  save(): void {
    if (!this.canSave()) return;
    this.requests += 1;
    const requestId = `save-${String(this.requests)}`;
    const step = savePage(this.state, requestId, this.input);
    if (step.send === null) return;
    // Reserved before the hand-over: an answer delivered while sending
    // finds its Save; a send that fails is rolled back.
    const before = this.state;
    const previous = this.waiting;
    this.state = step.state;
    const waiting: WaitingSave = {
      requestId,
      editRevision: this.editRevision,
      unknown: false,
      timer: this.deps.after(SAVE_ANSWER_TIMEOUT_MS, () => {
        if (this.waiting !== waiting) return;
        waiting.unknown = true;
        this.deps.view.setMessage(NO_ANSWER);
        this.render();
      }),
    };
    this.waiting = waiting;
    this.deps.view.setMessage("Sending…");
    if (!this.deps.transport.send(step.send)) {
      waiting.timer.cancel();
      if (this.waiting === waiting) {
        this.state = before;
        this.waiting = previous;
      }
      this.deps.view.setMessage(NOT_CONNECTED);
    } else {
      previous?.timer.cancel();
    }
    this.render();
  }

  /** The waiting page's manual Retry: the same hello or confirm; never a Save. */
  retry(): void {
    if (this.closed) return;
    this.apply(retryHandshake(this.state));
  }

  /** After a reset, a new page nonce; does nothing where binding cannot succeed. */
  reconnect(): void {
    if (this.closed) return;
    this.apply(reconnectPage(this.state, this.deps.newNonce()));
  }

  /** The socket closed or failed: nothing more is sent or taken. */
  transportClosed(): void {
    this.closed = true;
    this.stopTracking(CLOSED_UNKNOWN);
    this.deps.view.setRecovery("none");
    this.deps.view.setSaveEnabled(false);
    this.deps.view.setStatus(DISCONNECTED);
    // Sending and reading lines describe a session that is gone.
    this.deps.view.setDetails([]);
  }

  /**
   * The page can no longer learn a waiting Save's answer: it was handed
   * over, so it is neither cancelled nor unsent; its outcome is unknown.
   * Without a waiting Save nothing is said.
   */
  private stopTracking(unknownText: string): void {
    const waiting = this.waiting;
    if (waiting === null) return;
    waiting.timer.cancel();
    this.waiting = null;
    this.deps.view.setMessage(unknownText);
  }

  private nonceOf(state: PageState): string {
    return state.kind === "ended" ? this.deps.newNonce() : state.pageNonce;
  }

  private canSave(): boolean {
    return (
      !this.closed && this.state.kind === "bound" && (this.waiting === null || this.waiting.unknown)
    );
  }

  private apply(step: PageStep): void {
    const before = this.state;
    this.state = step.state;
    if (step.send !== null && !this.deps.transport.send(step.send)) {
      this.deps.view.setMessage(NOT_CONNECTED);
    }
    if (this.state !== before) this.afterChange(before);
    this.render();
  }

  private afterChange(before: PageState): void {
    const state = this.state;
    if (state.kind !== "bound") {
      if (state.kind === "ended" || before.kind === "bound")
        this.stopTracking(SESSION_ENDED_UNKNOWN);
      return;
    }
    if (!this.filled && !this.dirty) {
      this.fill(initialAddress(state.status));
      this.filled = true;
    }
    const waiting = this.waiting;
    // Only the correlated answer ends this Save; the reducer took it only if
    // it is the latest request of this binding.
    if (waiting !== null && state.lastSave?.requestId === waiting.requestId) {
      waiting.timer.cancel();
      this.waiting = null;
      const { outcome, error } = state.lastSave;
      this.deps.view.setMessage(outcomeText(outcome, error));
      const settled =
        outcome === "sent" ||
        outcome === "sent_superseded" ||
        outcome === "unchanged" ||
        outcome === "saved_not_active";
      // A newer edit since the request is kept; otherwise the field shows
      // what is saved now.
      if (settled && waiting.editRevision === this.editRevision) {
        this.fill(initialAddress(state.status));
      }
    }
  }

  private fill(value: string): void {
    this.input = value;
    this.dirty = false;
    this.deps.view.setInput(value);
  }

  private render(): void {
    if (this.closed) return;
    const { view } = this.deps;
    const state = this.state;
    switch (state.kind) {
      case "awaiting":
      case "confirming":
        view.setStatus(WAITING);
        view.setDetails([]);
        view.setRecovery("retry");
        break;
      case "bound":
        view.setStatus(statusText(state.status));
        view.setDetails(detailLines(state.status));
        view.setRecovery("none");
        break;
      case "ended":
        view.setStatus(
          state.reason === "reopen_required"
            ? "This inspector is no longer current. Close and reopen it."
            : "The connection to the plugin was reset.",
        );
        view.setDetails([]);
        view.setRecovery(state.reason === "session_reset" ? "reconnect" : "none");
        break;
    }
    view.setSaveEnabled(this.canSave());
  }
}

/** The address the field starts with: the saved one, else the one in use. */
function initialAddress(status: ConnectionStatusView): string {
  if (status.saved.kind === "ok") return status.saved.daemonUrl;
  return status.active?.daemonUrl ?? "";
}
