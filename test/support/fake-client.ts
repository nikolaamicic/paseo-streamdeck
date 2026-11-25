import type { ConnectionState } from "@getpaseo/client";
import type {
  AgentFeedClient,
  FeedObserver,
  FeedSubscription,
  IntervalScheduler,
} from "../../src/paseo/agent-feed.ts";
import { SERVER_ID } from "./fixtures.ts";

/**
 * Manual clock: link polling runs only when a test calls `tick()`, one-shot
 * timers only when it calls `advance()`.
 */
export class ManualScheduler implements IntervalScheduler {
  private readonly callbacks = new Set<() => void>();
  private readonly timers = new Set<{ due: number; callback: () => void }>();
  private now = 0;

  after(delayMs: number, callback: () => void): { cancel(): void } {
    const timer = { due: this.now + delayMs, callback };
    this.timers.add(timer);
    return {
      cancel: () => {
        this.timers.delete(timer);
      },
    };
  }

  /** One-shot timers that are scheduled and not yet run or cancelled. */
  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Moves the clock forward, running due one-shot timers in order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers]
        .filter((timer) => timer.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (due === undefined) break;
      this.timers.delete(due);
      this.now = due.due;
      due.callback();
    }
    this.now = target;
  }

  every(_intervalMs: number, callback: () => void): { cancel(): void } {
    this.callbacks.add(callback);
    return {
      cancel: () => {
        this.callbacks.delete(callback);
      },
    };
  }

  get active(): number {
    return this.callbacks.size;
  }

  tick(): void {
    for (const callback of [...this.callbacks]) callback();
  }
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

/**
 * Fake workspace directory of the client: the same subscription contract as
 * the agent directory (initial snapshot on subscribe, later snapshots and
 * updates via emit*).
 */
export class FakeDirectory {
  initialSnapshot: unknown = { entries: [], pageInfo: { hasMore: false } };
  deliverInitialSnapshot = true;
  listGate: Promise<void> | null = null;
  listError: Error | null = null;
  subscribeError: Error | null = null;
  /** Thrown by the unsubscribe function the subscription hands out. */
  unsubscribeError: Error | null = null;
  releaseError: Error | null = null;
  listCalls: unknown[] = [];
  observers = new Set<FeedObserver>();
  released = 0;

  private readonly updateType: string;

  constructor(updateType: string) {
    this.updateType = updateType;
  }

  readonly list = async (options: unknown): Promise<{ subscription: FeedSubscription }> => {
    this.listCalls.push(options);
    if (this.listGate) await this.listGate;
    if (this.listError) throw this.listError;
    const subscription: FeedSubscription = {
      subscribe: (observer) => {
        if (this.subscribeError !== null) throw this.subscribeError;
        this.observers.add(observer);
        if (this.deliverInitialSnapshot) observer.snapshot(this.initialSnapshot);
        return () => {
          this.observers.delete(observer);
          if (this.unsubscribeError !== null) throw this.unsubscribeError;
        };
      },
      release: () => {
        this.released += 1;
        return this.releaseError === null ? Promise.resolve() : Promise.reject(this.releaseError);
      },
    };
    return { subscription };
  };

  emitSnapshot(value: unknown): void {
    for (const observer of this.observers) observer.snapshot(value);
  }

  emitUpdate(payload: unknown): void {
    for (const observer of this.observers) observer.update({ type: this.updateType, payload });
  }

  emitError(error: unknown): void {
    for (const observer of this.observers) observer.error?.(error);
  }
}

/**
 * In-memory stand-in for the PaseoClient subset the feed uses. It mirrors
 * the documented SDK contract: a new observer receives the current snapshot
 * immediately; reconnect delivers a new snapshot to the same subscription.
 */
export class FakeClient implements AgentFeedClient {
  state: ConnectionState = { status: "idle" };
  serverId = SERVER_ID;
  initialSnapshot: unknown = { entries: [], pageInfo: { hasMore: false } };
  hostsListGate: Promise<void> | null = null;
  hostsListError: Error | null = null;
  /** One gate per hosts.list call, consumed in order before hostsListGate. */
  hostsListGates: Promise<void>[] = [];
  connectGate: Promise<void> | null = null;
  connectError: Error | null = null;
  listGate: Promise<void> | null = null;
  releaseError: Error | null = null;
  closeError: Error | null = null;
  /** Holds close() until it resolves; the client is not disposed meanwhile. */
  closeGate: Promise<void> | null = null;
  /** A rejected close leaves the client disposed (as before C3b1). */
  closeErrorDisposes = true;
  /** close() resolves without the client reaching "disposed". */
  closeLeavesState = false;
  /** getConnectionState() throws this. */
  stateError: Error | null = null;
  subscribeError: Error | null = null;
  /** Thrown by the unsubscribe function the subscription hands out. */
  unsubscribeError: Error | null = null;
  /** False emulates a disconnect between list() and subscribe(): no snapshot yet. */
  deliverInitialSnapshot = true;
  connectCalls = 0;
  listCalls: unknown[] = [];
  observers = new Set<FeedObserver>();
  released = 0;
  closed = 0;
  readonly workspaces = new FakeDirectory("workspace_update");

  /**
   * Project list answers (P1), consumed in order; when none is queued, the
   * descriptors of `listedProjects` (none by default) as the daemon sends
   * them (defaultProjectList).
   */
  readonly projectListAnswers: Promise<unknown>[] = [];
  listedProjects: Record<string, unknown>[] = [];
  projectListCalls = 0;
  /** The options of every list request, in order. */
  readonly projectListRequests: unknown[] = [];
  readonly projects = {
    list: (options?: unknown): Promise<unknown> => {
      this.projectListCalls += 1;
      this.projectListRequests.push(options);
      return this.projectListAnswers.shift() ?? Promise.resolve(this.defaultProjectList(options));
    },
  };

  /**
   * As the daemon handler read from the installed Paseo app 0.17.4
   * (handleProjectListRequest) answers: the sync position only when the
   * request has a `sync` field; without a cursor a full snapshot
   * ("no_cursor") whose entries carry their `syncSeq`.
   */
  private defaultProjectList(options: unknown): unknown {
    const asked = typeof options === "object" && options !== null && "sync" in options;
    if (!asked) return { requestId: "fake", projects: this.listedProjects };
    return {
      requestId: "fake",
      projects: this.listedProjects.map((project, index) => ({ ...project, syncSeq: index + 1 })),
      sync: {
        generation: "g1",
        headSeq: this.listedProjects.length,
        mode: "snapshot",
        reason: "no_cursor",
        removals: [],
      },
    };
  }
  /** The project.update subscription (P1); see FakeEventSubscription. */
  readonly projectEvents = new FakeEventSubscription();
  observeEventsCalls = 0;
  /** observeEvents throws this, synchronously. */
  observeEventsError: Error | null = null;
  /** The events of each observeEvents call. */
  readonly observedEvents: string[][] = [];
  observeEvents(events: ["project.update"]): FeedSubscription {
    this.observeEventsCalls += 1;
    this.observedEvents.push([...events]);
    if (this.observeEventsError !== null) throw this.observeEventsError;
    return this.projectEvents.handle();
  }

  /** Answers of providers.listUsage, consumed in order; none → rejects. */
  readonly usageAnswers: Promise<unknown>[] = [];
  usageCalls = 0;
  readonly providers = {
    listUsage: (): Promise<unknown> => {
      this.usageCalls += 1;
      return this.usageAnswers.shift() ?? Promise.reject(new Error("no usage answer"));
    },
  };

  readonly hosts = {
    list: async (): Promise<{ self: { serverId: string } }> => {
      const gate = this.hostsListGates.shift() ?? this.hostsListGate;
      if (gate) await gate;
      if (this.hostsListError) throw this.hostsListError;
      return { self: { serverId: this.serverId } };
    },
  };

  readonly agents = {
    list: async (options: unknown): Promise<{ subscription: FeedSubscription }> => {
      this.listCalls.push(options);
      if (this.listGate) await this.listGate;
      const subscription: FeedSubscription = {
        subscribe: (observer) => {
          if (this.subscribeError !== null) throw this.subscribeError;
          this.observers.add(observer);
          if (this.deliverInitialSnapshot) observer.snapshot(this.initialSnapshot);
          return () => {
            this.observers.delete(observer);
            if (this.unsubscribeError !== null) throw this.unsubscribeError;
          };
        },
        release: () => {
          this.released += 1;
          return this.releaseError === null ? Promise.resolve() : Promise.reject(this.releaseError);
        },
      };
      return { subscription };
    },
  };

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.state = { status: "connecting", attempt: 0 };
    if (this.connectGate) await this.connectGate;
    if (this.closed > 0) throw new Error("Daemon client is closed");
    if (this.connectError) {
      this.state = { status: "disconnected", reason: this.connectError.message };
      throw this.connectError;
    }
    this.state = { status: "connected" };
  }

  /**
   * Like PaseoClient.close (0.15.4): the client reports "disposed" only once
   * close has finished, so a close held by `closeGate` is not yet disposed.
   * A rejected close may still have disposed the client (when only the API
   * cleanup failed, `finally` disposes it): `closeErrorDisposes`.
   */
  async close(): Promise<void> {
    this.closed += 1;
    if (this.closeGate) await this.closeGate;
    if (this.closeError) {
      if (this.closeErrorDisposes) this.state = { status: "disposed" };
      throw this.closeError;
    }
    if (!this.closeLeavesState) this.state = { status: "disposed" };
  }

  getConnectionState(): ConnectionState {
    if (this.stateError !== null) throw this.stateError;
    return this.state;
  }

  emitSnapshot(value: unknown): void {
    for (const observer of this.observers) observer.snapshot(value);
  }

  emitUpdate(payload: unknown): void {
    for (const observer of this.observers) observer.update({ type: "agent_update", payload });
  }

  emitError(error: unknown): void {
    for (const observer of this.observers) observer.error?.(error);
  }
}

/**
 * A session event subscription (P1, `project.update`) as the SDK's owned
 * observation behaves: a subscriber gets the activation snapshot at once
 * when active; `reactivate()` is a new snapshot (a reconnect), `fail()` the
 * observer's error. Each handle() is one subscription; release is counted.
 */
export class FakeEventSubscription {
  observers = new Set<FeedObserver>();
  /** Deliver the activation snapshot on subscribe. */
  activeOnSubscribe = true;
  released = 0;
  releaseError: Error | null = null;
  /** Holds every release until it resolves. */
  releaseGate: Promise<void> | null = null;
  /** The unsubscribe function throws this. */
  unsubscribeError: Error | null = null;
  unsubscribed = 0;

  handle(): FeedSubscription {
    return {
      subscribe: (observer) => {
        this.observers.add(observer);
        if (this.activeOnSubscribe) observer.snapshot({ requestId: "fake", subscriptionId: "sub" });
        return () => {
          this.unsubscribed += 1;
          this.observers.delete(observer);
          if (this.unsubscribeError !== null) throw this.unsubscribeError;
        };
      },
      release: async () => {
        this.released += 1;
        // Each release's outcome is fixed when it is called, as a real one is.
        const error = this.releaseError;
        if (this.releaseGate !== null) await this.releaseGate;
        if (error !== null) throw error;
      },
    };
  }

  reactivate(): void {
    for (const observer of [...this.observers]) {
      observer.snapshot({ requestId: "fake", subscriptionId: "sub-2" });
    }
  }

  emit(payload: unknown): void {
    for (const observer of [...this.observers]) {
      observer.update({ type: "project.update", payload });
    }
  }

  fail(): void {
    for (const observer of [...this.observers])
      observer.error?.(new Error("raw subscription error"));
  }
}

/** Lets queued feed operations (a promise chain) run to completion. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}
