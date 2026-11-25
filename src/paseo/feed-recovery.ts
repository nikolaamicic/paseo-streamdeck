import { within, type Deadline, type Timers } from "./deadline.ts";
import type { FeedCloseOutcome } from "./agent-feed.ts";
import { AgentFeedError, type AgentFeedErrorCode } from "./feed-diagnostics.ts";

/** The owner's K2 decision (2026-11-15): retry 30 s after a terminal failure. */
export const RETRY_DELAY_MS = 30_000;

/**
 * Bound for one start (connect, host identity, first snapshot). A local
 * daemon does this in about a second (W3 gate: both snapshots 1.5 s after a
 * reconnect); 15 s leaves room for a slowly starting Paseo app.
 */
export const START_TIMEOUT_MS = 15_000;

/** The part of AgentFeed the owner needs. */
export interface RecoverableFeed {
  start(): Promise<void>;
  /** AgentFeed.close; a rejection still counts as an unconfirmed client close. */
  close(): Promise<FeedCloseOutcome>;
}

/**
 * What stop() confirmed about every feed this owner created (C3b1):
 * "closed" only if each client close was confirmed (FeedCloseOutcome),
 * "failed" if any was not, also one closed earlier during a retry, and
 * "none" if no feed was ever created. SDK disposal confirmation only, not
 * a closed socket (see FeedCloseOutcome).
 */
export interface StopOutcome {
  readonly client: "closed" | "failed" | "none";
}

export type RecoveryState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "running" }
  /** The failed feed is being closed; the retry is scheduled afterwards. */
  | { readonly kind: "failing"; readonly error: AgentFeedErrorCode }
  /** One retry timer is scheduled; Retry may start the attempt now. */
  | { readonly kind: "waiting"; readonly error: AgentFeedErrorCode }
  /** Authentication failed: no automatic retry, only an explicit Retry. */
  | { readonly kind: "blocked"; readonly error: AgentFeedErrorCode }
  | { readonly kind: "stopped" };

/** Stable codes for logging; never raw errors or IDs. */
export type RecoveryEvent =
  | { readonly kind: "attempt" }
  | { readonly kind: "started" }
  | { readonly kind: "failed"; readonly error: AgentFeedErrorCode }
  | { readonly kind: "cleanup_failed" }
  /** onChange threw; the lifecycle continued. */
  | { readonly kind: "observer_failed" }
  /** An unexpected internal error; the lifecycle state is kept. */
  | { readonly kind: "internal_error" };

export interface FeedRecoveryOptions<F extends RecoverableFeed> {
  /**
   * Builds a fresh feed with its own client. The feed calls
   * `onTerminalFailure` when it fails after a successful start.
   */
  createFeed(onTerminalFailure: (error: AgentFeedErrorCode) => void): F;
  readonly timers: Timers;
  onChange?(): void;
  onEvent?(event: RecoveryEvent): void;
  readonly retryDelayMs?: number;
  readonly startTimeoutMs?: number;
}

function errorCode(error: unknown): AgentFeedErrorCode {
  return error instanceof AgentFeedError ? error.code : "connect_failed";
}

/**
 * K2 owner of the feed lifecycle, at the top of the plugin. It holds at most
 * one feed (with its client), at most one retry timer and runs one attempt
 * at a time. Ordinary disconnects are left to the SDK's reconnect; only
 * terminal failures (a failed or timed-out start, a failed subscription)
 * end here. The next attempt is scheduled only after the failed feed is
 * closed, so attempts never pile up.
 */
export class FeedRecovery<F extends RecoverableFeed> {
  private readonly options: FeedRecoveryOptions<F>;
  private readonly retryDelayMs: number;
  private readonly startTimeoutMs: number;
  private stateValue: RecoveryState = { kind: "idle" };
  private current: F | null = null;
  private retryTimer: { cancel(): void } | null = null;
  /** The bounded start of the current attempt; cancelled on failure or stop. */
  private startWait: Deadline<void> | null = null;
  /** Feed closes in progress; stop() waits for all of them. */
  private readonly closing = new Set<Promise<void>>();
  private stopping: Promise<StopOutcome> | null = null;
  /** A feed was created at least once. */
  private created = false;
  /**
   * Sticky: some created feed's client close was not confirmed. A flag, not
   * a list, so finished closes keep no feed references.
   */
  private clientUnconfirmed = false;

  constructor(options: FeedRecoveryOptions<F>) {
    this.options = options;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  }

  get state(): RecoveryState {
    return this.stateValue;
  }

  /** The feed being started or running; null otherwise. */
  get feed(): F | null {
    return this.current;
  }

  get retryAvailable(): boolean {
    return this.stateValue.kind === "waiting" || this.stateValue.kind === "blocked";
  }

  /** Starts the first attempt; later calls have no effect. */
  start(): void {
    if (this.stateValue.kind === "idle") this.launch();
  }

  /**
   * Explicit Retry: cancels a scheduled retry and starts one attempt now.
   * Returns false (and does nothing) unless a retry is available, so rapid
   * presses start at most one attempt.
   */
  retryNow(): boolean {
    if (!this.retryAvailable) return false;
    this.cancelRetry();
    this.launch();
    return true;
  }

  /**
   * Cancels any retry and start deadline, closes the current feed and
   * resolves once every close already in progress has finished, with what
   * was confirmed about all feeds (StopOutcome). It has no deadline: a close
   * that never finishes keeps it pending. Repeated calls return the same
   * promise. Nothing restarts afterwards.
   */
  stop(): Promise<StopOutcome> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<StopOutcome> {
    this.cancelRetry();
    this.cancelStartWait();
    const feed = this.current;
    this.current = null;
    this.setState({ kind: "stopped" });
    if (feed !== null) void this.closeFeed(feed);
    await Promise.all([...this.closing]);
    if (!this.created) return { client: "none" };
    return { client: this.clientUnconfirmed ? "failed" : "closed" };
  }

  /** Runs an attempt; an unexpected error is reported, never left unhandled. */
  private launch(): void {
    this.attempt().catch(() => {
      this.report({ kind: "internal_error" });
    });
  }

  private async attempt(): Promise<void> {
    // Everything up to the first await runs synchronously, so the state is
    // "starting" before any second caller can look at it.
    this.setState({ kind: "starting" });
    this.report({ kind: "attempt" });
    let feed: F;
    try {
      feed = this.options.createFeed((error) => {
        this.onTerminalFailure(feed, error);
      });
    } catch {
      await this.recover(null, "connect_failed");
      return;
    }
    this.created = true;
    this.current = feed;
    const wait = within(feed.start(), this.startTimeoutMs, this.options.timers);
    this.startWait = wait;
    const result = await wait.settled;
    if (this.startWait === wait) this.startWait = null;
    // Stopped, or a terminal failure already took this feed over.
    if (this.isStopped() || this.current !== feed || result.kind === "cancelled") return;
    if (result.kind === "value") {
      this.setState({ kind: "running" });
      this.report({ kind: "started" });
      return;
    }
    await this.recover(feed, result.kind === "timeout" ? "start_timeout" : errorCode(result.error));
  }

  /**
   * A terminal failure of the current feed, while starting or running. It can
   * arrive after the start succeeded but before the attempt continued, so the
   * start wait is cancelled and the failure is handled here exactly once.
   */
  private onTerminalFailure(feed: F, error: AgentFeedErrorCode): void {
    if (this.current !== feed) return;
    if (this.stateValue.kind !== "starting" && this.stateValue.kind !== "running") return;
    this.cancelStartWait();
    this.recover(feed, error).catch(() => {
      this.report({ kind: "internal_error" });
    });
  }

  /** Closes the failed feed first, then waits for a retry or for the user. */
  private async recover(feed: F | null, error: AgentFeedErrorCode): Promise<void> {
    this.current = null;
    this.report({ kind: "failed", error });
    this.setState({ kind: "failing", error });
    if (feed !== null) await this.closeFeed(feed);
    if (this.isStopped()) return;
    if (error === "auth_failed") {
      this.setState({ kind: "blocked", error });
      return;
    }
    this.retryTimer = this.options.timers.after(this.retryDelayMs, () => {
      this.retryTimer = null;
      if (this.stateValue.kind === "waiting") this.launch();
    });
    this.setState({ kind: "waiting", error });
  }

  /**
   * Closes a feed; tracked until done so stop() can wait for it. Any
   * cleanup failure is reported as before; an unconfirmed client close (or
   * an unexpected rejection: fail-closed) is remembered for stop().
   */
  private closeFeed(feed: F): Promise<void> {
    const tracked = Promise.resolve()
      .then(() => feed.close())
      .then(
        (outcome) => {
          if (outcome.client !== "closed") this.clientUnconfirmed = true;
          if (outcome.subscriptions !== "released" || outcome.client !== "closed") {
            this.report({ kind: "cleanup_failed" });
          }
        },
        () => {
          this.clientUnconfirmed = true;
          this.report({ kind: "cleanup_failed" });
        },
      )
      .finally(() => {
        this.closing.delete(tracked);
      });
    this.closing.add(tracked);
    return tracked;
  }

  private cancelStartWait(): void {
    this.startWait?.cancel();
    this.startWait = null;
  }

  private cancelRetry(): void {
    this.retryTimer?.cancel();
    this.retryTimer = null;
  }

  /** Re-reads the state after an await; `stop()` may have run meanwhile. */
  private isStopped(): boolean {
    return this.stateValue.kind === "stopped";
  }

  private setState(state: RecoveryState): void {
    this.stateValue = state;
    try {
      this.options.onChange?.();
    } catch {
      this.report({ kind: "observer_failed" });
    }
  }

  /** An event sink that throws cannot be reported through itself; it is dropped. */
  private report(event: RecoveryEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Dropped on purpose: no recursion, the lifecycle continues.
    }
  }
}
