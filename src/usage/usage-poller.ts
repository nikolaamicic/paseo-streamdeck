import { within, type Deadline, type Settled, type Timers } from "../paseo/deadline.ts";
import { parseUsageList, type UsageSnapshot } from "./usage-model.ts";

/**
 * Polls account quota usage (U2) while at least one Usage dial is visible.
 *
 * Timing: a request is due when polling starts, when the connection
 * generation changes (another feed, a reconnect, another host) and when the
 * interval passed since the previous answer, failure or timeout. Nothing
 * else makes it due: ordinary feed changes never shorten the interval, so
 * a failing daemon is asked at most once per interval and generation. The
 * daemon caches usage (5 minutes in 0.15.4) and the public call has no
 * force-refresh, so a shorter interval would not give newer data.
 *
 * Validity: every request is tied to the generation it was sent on, and is
 * sent only while the feed is settled (host confirmed by fresh snapshots).
 * When the generation changes, the link drops or the feed resyncs, the
 * poller stops waiting for it and ignores its answer, so an answer from an old connection or an
 * earlier host (also A → B → A) is never accepted, and another host's
 * quota is never returned.
 *
 * Limit: the public `listUsage()` (@getpaseo/client 0.15.4) takes no abort
 * signal, so an abandoned request is not cancelled on the transport. The
 * poller waits for at most one request at a time; an abandoned one may
 * still be answered by the daemon and is then discarded.
 *
 * Nothing is logged here; failures are only reported as "not updated".
 */

export const USAGE_POLL_INTERVAL_MS = 5 * 60_000;
export const USAGE_REQUEST_TIMEOUT_MS = 15_000;

/** The connection usage is read from; null before the first feed exists. */
export interface UsageSource {
  /**
   * Stable identity of the connection owner (the feed instance), compared
   * by reference; a new owner is a new generation.
   */
  readonly owner: object;
  /** Changes on every (re)connect of the owner's link. */
  readonly connectionEpoch: number;
  /** Identity of the connected daemon; null while unknown. */
  readonly serverId: string | null;
  readonly connected: boolean;
  /**
   * The feed's data is current: after a (re)connect the host identity was
   * confirmed by fresh snapshots. Usage is asked only then, so it is never
   * filed under a host that is about to be replaced.
   */
  readonly settled: boolean;
  listUsage(): Promise<unknown>;
}

export interface UsagePollerOptions {
  readonly timers: Timers;
  readonly source: () => UsageSource | null;
  /** Called after every change of `state`; never after dispose(). */
  readonly onChange: () => void;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

export interface UsageState {
  /** The last usage read from the current host; null when none yet. */
  readonly snapshot: UsageSnapshot | null;
  /** The last request for the current host failed, timed out or was malformed. */
  readonly failed: boolean;
  /** A request is awaited. */
  readonly pending: boolean;
  /**
   * The snapshot was read on an earlier connection (or the connection is
   * not settled yet) and nothing newer has arrived: last known, not current.
   */
  readonly outdated: boolean;
}

interface Generation {
  readonly owner: object;
  readonly epoch: number;
  readonly host: string;
}

interface Request {
  readonly deadline: Deadline<unknown>;
  readonly generation: Generation;
}

function sameGeneration(a: Generation | null, b: Generation | null): boolean {
  return (
    a !== null && b !== null && a.owner === b.owner && a.epoch === b.epoch && a.host === b.host
  );
}

/** The source's current generation; null while it cannot be asked. */
function generationOf(source: UsageSource | null): Generation | null {
  if (source === null || !source.connected || !source.settled || source.serverId === null) {
    return null;
  }
  return { owner: source.owner, epoch: source.connectionEpoch, host: source.serverId };
}

export class UsagePoller {
  private readonly options: Required<UsagePollerOptions>;
  private active = false;
  private disposed = false;
  private data: { readonly generation: Generation; readonly snapshot: UsageSnapshot } | null = null;
  /** Host whose last request failed; failures of another host do not count. */
  private failedHost: string | null = null;
  private request: Request | null = null;
  /** The interval timer; a request is due when it fires. */
  private timer: { cancel(): void } | null = null;
  private due = false;
  /** Generation seen at the last sync; a change makes a request due. */
  private seen: Generation | null = null;

  constructor(options: UsagePollerOptions) {
    this.options = {
      intervalMs: USAGE_POLL_INTERVAL_MS,
      timeoutMs: USAGE_REQUEST_TIMEOUT_MS,
      ...options,
    };
  }

  /** What the dials show; data of another host is never returned. */
  get state(): UsageState {
    const source = this.options.source();
    const host = source?.serverId ?? null;
    const data = this.data;
    const shown = data !== null && host !== null && data.generation.host === host ? data : null;
    return {
      snapshot: shown?.snapshot ?? null,
      failed: host !== null && this.failedHost === host,
      pending: this.request !== null,
      outdated: shown !== null && !sameGeneration(shown.generation, generationOf(source)),
    };
  }

  /**
   * Polling runs only while a Usage dial is visible. Turning it off stops
   * the timer, abandons a request and forgets the data, so a dial that
   * reappears never shows old quota as if current.
   */
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (active) {
      this.due = true;
      this.sync();
      return;
    }
    this.abandon();
    this.timer?.cancel();
    this.timer = null;
    this.due = false;
    this.seen = null;
    this.data = null;
    this.failedHost = null;
  }

  /** After a feed change: follows the generation and asks when a request is due. */
  sync(): void {
    if (this.disposed || !this.active) return;
    const current = generationOf(this.options.source());
    if (!sameGeneration(current, this.seen)) {
      // A drop, reconnect, new feed or new host: the old answer is void.
      if (this.request !== null && !sameGeneration(current, this.request.generation)) {
        this.abandon();
        this.options.onChange();
      }
      if (current !== null) this.due = true;
      this.seen = current;
    }
    if (this.due && current !== null && this.request === null) this.poll(current);
  }

  dispose(): void {
    this.disposed = true;
    this.abandon();
    this.timer?.cancel();
    this.timer = null;
  }

  private abandon(): void {
    this.request?.deadline.cancel();
    this.request = null;
  }

  private poll(generation: Generation): void {
    const source = this.options.source();
    if (source === null) return;
    this.due = false;
    this.timer?.cancel();
    this.timer = null;
    let operation: Promise<unknown>;
    try {
      operation = source.listUsage();
    } catch {
      // A synchronous throw counts like a failed request; its reason is not kept.
      operation = Promise.reject(new Error("usage_request_failed"));
    }
    const request: Request = {
      deadline: within(operation, this.options.timeoutMs, this.options.timers),
      generation,
    };
    this.request = request;
    this.options.onChange();
    void request.deadline.settled.then((result) => {
      this.settle(request, result);
    });
  }

  private settle(request: Request, result: Settled<unknown>): void {
    // Abandoned (hidden, disposed, or its generation ended): counts for nothing.
    if (this.disposed || this.request !== request || result.kind === "cancelled") return;
    this.request = null;
    if (!sameGeneration(generationOf(this.options.source()), request.generation)) {
      // The generation changed without a sync in between: ask again.
      this.options.onChange();
      this.sync();
      return;
    }
    const host = request.generation.host;
    const snapshot = result.kind === "value" ? parseUsageList(result.value) : null;
    if (snapshot === null) {
      this.failedHost = host;
    } else {
      this.data = { generation: request.generation, snapshot };
      this.failedHost = null;
    }
    this.timer = this.options.timers.after(this.options.intervalMs, () => {
      this.timer = null;
      this.due = true;
      this.sync();
    });
    this.options.onChange();
  }
}
