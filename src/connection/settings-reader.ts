import type { Timers } from "../paseo/deadline.ts";
import { isPlainObject } from "./connection-model.ts";

/**
 * Owner of the plugin's global settings as read from Stream Deck (C3a2).
 * It reads them, follows
 * changes made outside the plugin and keeps them fresh; it does not choose
 * or change the connection (the feed lifecycle does, C3a3) and does not
 * write: the Save owner (connection-saver.ts, C4a1) writes and reports each
 * write here, so the known state and the revision have this one owner. The
 * feed lifecycle starts it after `streamDeck.connect()`.
 *
 * SDK facts it relies on (`@elgato/streamdeck` 3.0.4, dist/plugin/settings.js
 * and @elgato/utils event-emitter.js):
 * - `getGlobalSettings()` resolves on the next `didReceiveGlobalSettings`
 *   of any origin; it has no timeout, cannot be aborted and never rejects
 *   on its own.
 * - `onDidReceiveGlobalSettings` skips events that carry a request `id`
 *   (answers to a read) and gets the others (changes made outside).
 * - Listeners run synchronously in registration order; a read only
 *   continues on a later microtask. So an outside change that also settles
 *   a pending read is applied first, and the read then finds the revision
 *   changed and is dropped: the same event is applied once.
 */

/**
 * Bound for one read: a chosen user-facing limit for a local channel, the
 * same 5 s as the client's connect timeout and the inspector page's answer
 * timeout. It is not a measured or guaranteed answer time; it only makes
 * the user see "settings unavailable" instead of loading forever.
 */
export const SETTINGS_READ_TIMEOUT_MS = 5_000;

/** The newest settings state applied, by revision. */
export type KnownSettings =
  | { readonly kind: "none" }
  /** A whole plain object: the base a later Save may modify (C4a). */
  | { readonly kind: "loaded"; readonly settings: Readonly<Record<string, unknown>> }
  /** The newest value was not a plain object; nothing reliable to modify. */
  | { readonly kind: "malformed" };

/** The most recent read attempt; separate from what is known. */
export type ReadStatus = "idle" | "pending" | "timed_out" | "failed";

export interface SettingsReaderState {
  readonly known: KnownSettings;
  readonly read: ReadStatus;
  /** Rises with every applied read, outside change, begun and applied write. */
  readonly revision: number;
}

/** One write between beginWrite and writeAccepted. */
export interface WriteTicket {
  readonly revision: number;
}

export interface SettingsReaderDeps {
  /** streamDeck.settings.getGlobalSettings */
  readonly getGlobalSettings: () => Promise<unknown>;
  /** streamDeck.settings.onDidReceiveGlobalSettings, giving the settings. */
  readonly subscribe: (listener: (settings: unknown) => void) => { dispose(): void };
  readonly timers: Timers;
  /**
   * Called after every change of what is known or of the read status, and
   * after the revision rises with them; never after dispose(). A begun write
   * (beginWrite) raises only the revision and is silent.
   */
  readonly onChange: () => void;
  readonly timeoutMs?: number;
}

export class GlobalSettingsReader {
  private readonly deps: SettingsReaderDeps;
  private known: KnownSettings = { kind: "none" };
  private readStatus: ReadStatus = "idle";
  private revision = 0;
  /** An SDK read that has not settled; at most one at a time. */
  private inFlight = false;
  private deadline: { cancel(): void } | null = null;
  private subscription: { dispose(): void } | null = null;
  private started = false;
  private disposed = false;

  /** Creating a reader reads nothing, subscribes to nothing, starts no timer. */
  constructor(deps: SettingsReaderDeps) {
    this.deps = deps;
  }

  get state(): SettingsReaderState {
    return { known: this.known, read: this.readStatus, revision: this.revision };
  }

  /** Subscribes to outside changes, then reads once. */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    this.subscription = this.deps.subscribe((settings) => {
      this.onOutsideChange(settings);
    });
    this.read();
  }

  /**
   * Reads again. A read still in flight is reused with a new deadline: the
   * SDK cannot abort it, so no second request is sent.
   */
  retry(): void {
    if (this.disposed || !this.started) return;
    if (!this.inFlight) {
      this.read();
      return;
    }
    this.readStatus = "pending";
    this.armDeadline();
    this.deps.onChange();
  }

  /**
   * A write of the whole settings object is about to be handed to the SDK
   * (C4a1). The revision rises now, before the write is sent, so every read
   * issued earlier is stale and can never apply content from before the
   * write; what is known does not change. Null after dispose().
   *
   * Silent on purpose: no onChange, so no outside code can run between the
   * caller's snapshot of `known` and its send. Nothing a view shows changed;
   * only reads in flight lost their right to apply.
   */
  beginWrite(): WriteTicket | null {
    if (this.disposed) return null;
    this.revision += 1;
    return { revision: this.revision };
  }

  /**
   * The SDK took the write of `ticket` (handed to Stream Deck, not confirmed
   * stored). `settings` becomes what is known only when nothing newer was
   * applied since beginWrite: a later outside change or read is kept, never
   * overwritten by this late success. Returns the revision it applied at,
   * taken before onChange (whose callback may already apply something newer),
   * or null when not applied. A failed write needs no call: what is known
   * stays as it was.
   */
  writeAccepted(ticket: WriteTicket, settings: Readonly<Record<string, unknown>>): number | null {
    if (this.disposed || ticket.revision !== this.revision) return null;
    this.revision += 1;
    const applied = this.revision;
    this.known = { kind: "loaded", settings };
    this.deps.onChange();
    return applied;
  }

  /**
   * Unsubscribes and cancels the deadline; later answers and events are
   * ignored and nothing is read again. An SDK read still in flight cannot
   * be aborted: its promise and once-listener stay until Stream Deck
   * answers, and its answer is then dropped.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelDeadline();
    this.subscription?.dispose();
    this.subscription = null;
  }

  private read(): void {
    const issuedAt = this.revision;
    let request: Promise<unknown>;
    try {
      request = this.deps.getGlobalSettings();
    } catch {
      // A synchronous throw is a failed read, like a rejection.
      this.readStatus = "failed";
      this.deps.onChange();
      return;
    }
    this.inFlight = true;
    this.readStatus = "pending";
    this.armDeadline();
    this.deps.onChange();
    request.then(
      (settings) => {
        this.settle(issuedAt, { ok: true, settings });
      },
      () => {
        this.settle(issuedAt, { ok: false });
      },
    );
  }

  private settle(
    issuedAt: number,
    result: { readonly ok: true; readonly settings: unknown } | { readonly ok: false },
  ): void {
    this.inFlight = false;
    if (this.disposed) return;
    this.cancelDeadline();
    if (issuedAt !== this.revision) {
      // Stale: something newer was applied or sent meanwhile.
      this.readStatus = "idle";
    } else if (result.ok) {
      this.readStatus = "idle";
      this.apply(result.settings);
    } else {
      this.readStatus = "failed";
    }
    this.deps.onChange();
  }

  private onOutsideChange(settings: unknown): void {
    if (this.disposed) return;
    this.apply(settings);
    this.deps.onChange();
  }

  /** The newest state; a malformed value still moves the revision. */
  private apply(settings: unknown): void {
    this.revision += 1;
    this.known = isPlainObject(settings) ? { kind: "loaded", settings } : { kind: "malformed" };
  }

  private armDeadline(): void {
    this.cancelDeadline();
    this.deadline = this.deps.timers.after(this.deps.timeoutMs ?? SETTINGS_READ_TIMEOUT_MS, () => {
      this.deadline = null;
      // The SDK read stays in flight; a late fresh answer still applies.
      this.readStatus = "timed_out";
      this.deps.onChange();
    });
  }

  private cancelDeadline(): void {
    this.deadline?.cancel();
    this.deadline = null;
  }
}
