import {
  decideSave,
  knownSaves,
  type ActiveConnection,
  type JsonObject,
  type SaveRefusal,
} from "./connection-save.ts";
import type { GlobalSettingsReader } from "./settings-reader.ts";

/**
 * The one owner of Save (C4a1):
 * it decides each Save from the facts at the moment it runs, writes the
 * whole global settings object through the SDK and reports the write to the
 * GlobalSettingsReader, the one owner of what is known. It never touches the
 * connection: the feed lifecycle follows the reader's known state, so a
 * written address is applied, or blocked, by the lifecycle's own rules.
 *
 * One write runs at a time, and at most one newer Save waits; a Save that
 * arrives while another waits replaces it ("replaced"). Every Save settles
 * with an explicit outcome, also after dispose(). Not wired into the plugin
 * yet (C4a2).
 *
 * `setGlobalSettings` resolving means the SDK handed the object to Stream
 * Deck (@elgato/streamdeck 3.0.4: `connection.send` → `ws.send`); there is
 * no acknowledgement and no request ID, so "sent" never means stored.
 */

export type SaveOutcome =
  | SaveRefusal
  /** Handed to Stream Deck; what is known now holds this address. */
  | { readonly kind: "sent" }
  /**
   * Handed to Stream Deck, but a newer state with another address arrived
   * while the write was pending, and that one is kept. Without SDK
   * correlation a late echo of this write cannot be told from any outside
   * change; an echo of the same address counts as "sent".
   */
  | { readonly kind: "sent_superseded" }
  /** The SDK refused or threw: nothing is known as written. */
  | { readonly kind: "not_sent" }
  /** A newer Save replaced this one before it started. */
  | { readonly kind: "replaced" }
  /** dispose() came first; a write already handed over cannot be recalled. */
  | { readonly kind: "stopped" };

/** The part of the reader Save uses. */
export type SaveReader = Pick<GlobalSettingsReader, "state" | "beginWrite" | "writeAccepted">;

export interface ConnectionSaverDeps {
  readonly reader: SaveReader;
  /** The connection a feed actually runs on now, if any. */
  readonly active: () => ActiveConnection | null;
  /** streamDeck.settings.setGlobalSettings; replaces the whole object. */
  readonly setGlobalSettings: (settings: JsonObject) => Promise<void>;
}

/** The latest write this saver applied, while it is still what is known. */
export interface SentConnection {
  readonly daemonUrl: string;
  /** Sent to Stream Deck, never confirmed stored. */
  readonly confirmed: false;
}

interface Pending {
  readonly raw: unknown;
  readonly settle: (outcome: SaveOutcome) => void;
}

/** A settle function that acts once; later calls do nothing. */
function once(resolve: (outcome: SaveOutcome) => void): (outcome: SaveOutcome) => void {
  let done = false;
  return (outcome) => {
    if (done) return;
    done = true;
    resolve(outcome);
  };
}

export class ConnectionSaver {
  private readonly deps: ConnectionSaverDeps;
  private running: Pending | null = null;
  private waiting: Pending | null = null;
  private lastSent: { readonly revision: number; readonly daemonUrl: string } | null = null;
  /** The normalized address of the write handed to the SDK and not yet settled. */
  private sendingUrl: string | null = null;
  private disposed = false;

  /** Creating a saver reads, writes and schedules nothing. */
  constructor(deps: ConnectionSaverDeps) {
    this.deps = deps;
  }

  /**
   * The address this saver sent, while it is what is known (no newer read,
   * outside change or write applied since); null otherwise.
   */
  get sent(): SentConnection | null {
    const last = this.lastSent;
    if (last?.revision !== this.deps.reader.state.revision) return null;
    return { daemonUrl: last.daemonUrl, confirmed: false };
  }

  /**
   * The address of the write the SDK is sending now (the requested one),
   * null when none is pending. Not known, not sent and not active yet.
   */
  get sending(): string | null {
    return this.sendingUrl;
  }

  /** Saves `raw` (unvalidated input) as the daemon address. */
  save(raw: unknown): Promise<SaveOutcome> {
    return new Promise<SaveOutcome>((resolve) => {
      const pending: Pending = { raw, settle: once(resolve) };
      if (this.disposed) {
        pending.settle({ kind: "stopped" });
        return;
      }
      if (this.running === null) {
        this.run(pending);
        return;
      }
      this.waiting?.settle({ kind: "replaced" });
      this.waiting = pending;
    });
  }

  /**
   * Settles the waiting and the running Save as "stopped". A write already
   * handed to the SDK cannot be recalled; its late result changes nothing.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.waiting?.settle({ kind: "stopped" });
    this.waiting = null;
    this.sendingUrl = null;
    this.running?.settle({ kind: "stopped" });
    this.running = null;
  }

  /**
   * Decides and, for a write, sends in one synchronous step from the facts
   * now, so a queued Save never uses an object built from older settings.
   * The Save is reserved as running first, so a reentrant save() queues and
   * dispose() settles it; beginWrite is silent, so no callback runs between
   * the snapshot and the send.
   */
  private run(pending: Pending): void {
    this.running = pending;
    const decision = decideSave(pending.raw, {
      known: this.deps.reader.state.known,
      active: this.deps.active(),
    });
    if (decision.kind !== "write") {
      this.finish(pending, decision);
      return;
    }
    const ticket = this.deps.reader.beginWrite();
    if (ticket === null) {
      this.finish(pending, { kind: "stopped" });
      return;
    }
    this.sendingUrl = decision.daemonUrl;
    let sending: Promise<void>;
    try {
      sending = this.deps.setGlobalSettings(decision.settings);
    } catch {
      // A synchronous throw is a refused send, like a rejection.
      sending = Promise.reject(new Error("setGlobalSettings threw"));
    }
    sending.then(
      () => {
        if (this.running !== pending) return;
        const { daemonUrl, settings } = decision;
        const applied = this.deps.reader.writeAccepted(ticket, settings);
        // The reader's callback may have disposed this saver.
        if (this.running !== pending) return;
        if (applied !== null) this.lastSent = { revision: applied, daemonUrl };
        // Judged on what is known now, after the reader's callback: a newer
        // state with another address is kept and reported, also when it
        // arrived during that callback; the same address is no conflict.
        const same = knownSaves(this.deps.reader.state.known, daemonUrl);
        this.finish(pending, { kind: same ? "sent" : "sent_superseded" });
      },
      () => {
        if (this.running !== pending) return;
        this.finish(pending, { kind: "not_sent" });
      },
    );
  }

  private finish(pending: Pending, outcome: SaveOutcome): void {
    if (this.running === pending) {
      this.running = null;
      this.sendingUrl = null;
    }
    pending.settle(outcome);
    this.next();
  }

  private next(): void {
    const waiting = this.waiting;
    if (this.disposed || waiting === null) return;
    this.waiting = null;
    this.run(waiting);
  }
}
