import type { ConnectionState } from "@getpaseo/client";
import { AgentDirectory, type DirectoryChange } from "../agents/agent-directory.ts";
import type { AgentRecord } from "../agents/agent-model.ts";
import { WorkspaceDirectory, type WorkspaceChange } from "../workspaces/workspace-directory.ts";
import type { WorkspaceRecord } from "../workspaces/workspace-model.ts";
import { parseAgentUpdate, parseDirectoryEntry } from "./agent-parser.ts";
import {
  AgentFeedError,
  feedWarning,
  type AgentFeedErrorCode,
  type FeedWarning,
  type FeedWarningCode,
  type WarningDetail,
} from "./feed-diagnostics.ts";
import { systemTimers, within, type Deadline, type Timers } from "./deadline.ts";
import { sameLinkState, toLinkState, type LinkState } from "./link-state.ts";
import {
  ProjectDirectorySync,
  type ProjectSyncClient,
  type ProjectsState,
} from "./project-sync.ts";
import { isWellFormed } from "./unknown-value.ts";
import { parseWorkspace, parseWorkspaceUpdate } from "./workspace-parser.ts";

export { AgentFeedError, type AgentFeedErrorCode, type FeedWarning } from "./feed-diagnostics.ts";

/** Directory pages are capped at 200 entries by @getpaseo/protocol 0.15.4. */
export const MAX_PAGE_LIMIT = 200;

/**
 * The SDK documents no connection-state event, only `getConnectionState()`.
 * Reading this in-memory getter sends nothing to the daemon.
 */
export const DEFAULT_LINK_POLL_INTERVAL_MS = 500;

/**
 * Upper bound for the host identity lookup when a reconnect snapshot arrives.
 * A local daemon answers in milliseconds; without a bound one hung request
 * would block the snapshot and update queue for good. On timeout the
 * previous data stays visible and marked stale until a snapshot is applied.
 */
export const RESYNC_HOST_TIMEOUT_MS = 10_000;

export interface FeedObserver {
  snapshot(snapshot: unknown): void;
  update(message: unknown): void;
  error?(error: unknown): void;
}

export interface FeedSubscription {
  subscribe(observer: FeedObserver): () => void;
  release(): Promise<void>;
}

interface ListOptions {
  subscribe: Record<string, never>;
  page: { limit: number };
  includeBackground?: boolean;
}

/**
 * The subset of `PaseoClient` (@getpaseo/client 0.15.4) the feed uses;
 * test/paseo/client-compat.ts checks that the real client satisfies it.
 */
export interface AgentFeedClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  getConnectionState(): ConnectionState;
  readonly hosts: { list(): Promise<{ readonly self: { readonly serverId: string } }> };
  readonly agents: {
    list(
      options: ListOptions & { filter?: { includeArchived?: boolean } },
    ): Promise<{ readonly subscription: FeedSubscription }>;
  };
  readonly workspaces: {
    list(options: ListOptions): Promise<{ readonly subscription: FeedSubscription }>;
  };
  /** Account quota usage (U2); the payload is read by parseUsageList. */
  readonly providers: { listUsage(): Promise<unknown> };
  /** All projects of the host (P1); the payload is read by parseProjectList. */
  readonly projects: ProjectSyncClient["projects"];
  /** A session event subscription (P1: `project.update` only). */
  observeEvents(events: ["project.update"]): FeedSubscription;
}

/**
 * What closing a feed confirmed (C3b1). `client: "closed"` means only SDK
 * disposal confirmation: PaseoClient.close() resolved and the public
 * getConnectionState() reports "disposed". In @getpaseo/client 0.15.4 that
 * disables reconnect and asks the transport to close, but disposeTransport
 * swallows a transport.close error, so it does not prove the socket or the
 * TCP connection closed. Anything else (a rejection, another status, a
 * throwing getter) is "failed": unconfirmed, never a success.
 */
export interface FeedCloseOutcome {
  /** The directory and project subscriptions were unsubscribed and released without error. */
  readonly subscriptions: "released" | "failed";
  readonly client: "closed" | "failed";
}

export interface IntervalScheduler extends Timers {
  every(intervalMs: number, callback: () => void): { cancel(): void };
}

const systemScheduler: IntervalScheduler = {
  after: (delayMs, callback) => systemTimers.after(delayMs, callback),
  every: (intervalMs, callback) => {
    const handle = setInterval(callback, intervalMs);
    return {
      cancel: () => {
        clearInterval(handle);
      },
    };
  },
};

export interface SnapshotInfo {
  readonly serverId: string;
  readonly count: number;
  /**
   * The daemon has more entries than one page. Only the first page is
   * observed: a known prototype limitation, not "all of them".
   */
  readonly truncated: boolean;
  readonly skipped: number;
}

export interface AgentFeedListener {
  onLinkState?(state: LinkState, stale: boolean): void;
  onSnapshot?(changes: readonly DirectoryChange[], info: SnapshotInfo): void;
  /**
   * A real directory change. Metadata-only changes (e.g. `updatedAt`) are
   * included; whether the display changes is for the renderer to decide.
   */
  onChange?(change: DirectoryChange): void;
  onWorkspaceSnapshot?(changes: readonly WorkspaceChange[], info: SnapshotInfo): void;
  onWorkspaceChange?(change: WorkspaceChange): void;
  /** Stable code and fixed text only; never raw error messages or payload values. */
  onWarning?(warning: FeedWarning): void;
  /** The project list or its status changed (P1). */
  onProjectsChange?(): void;
  /** A directory subscription failed; the feed will not recover on its own. */
  onFailure?(error: AgentFeedError): void;
}

export interface AgentFeedOptions {
  readonly includeArchived?: boolean;
  readonly includeBackground?: boolean;
  readonly pageLimit?: number;
  readonly linkPollIntervalMs?: number;
  readonly resyncHostTimeoutMs?: number;
  readonly scheduler?: IntervalScheduler;
}

function readSnapshotShape(snapshot: unknown): { entries: unknown[]; hasMore: boolean } | null {
  if (typeof snapshot !== "object" || snapshot === null || !("entries" in snapshot)) return null;
  const entries = snapshot.entries;
  if (!Array.isArray(entries)) return null;
  const pageInfo = "pageInfo" in snapshot ? snapshot.pageInfo : null;
  const hasMore =
    typeof pageInfo === "object" &&
    pageInfo !== null &&
    "hasMore" in pageInfo &&
    pageInfo.hasMore === true;
  return { entries, hasMore };
}

function readUpdatePayload(message: unknown, type: string): unknown {
  if (typeof message !== "object" || message === null) return undefined;
  if (!("type" in message) || message.type !== type) return undefined;
  return "payload" in message ? message.payload : undefined;
}

/** Bookkeeping for one directory subscription (agents or workspaces). */
interface Stream {
  readonly updateType: "agent_update" | "workspace_update";
  subscription: FeedSubscription | null;
  unsubscribe: (() => void) | null;
  /** Snapshots received but not yet applied. */
  pending: number;
  /** Snapshots applied: the initial one plus one per resync. */
  applied: number;
  /** No snapshot of the current round applied yet; data is not fresh. */
  awaiting: boolean;
  /** Connection round of the last snapshot received; -1 before the first. */
  round: number;
  truncated: boolean;
}

function newStream(updateType: Stream["updateType"]): Stream {
  return {
    updateType,
    subscription: null,
    unsubscribe: null,
    pending: 0,
    applied: 0,
    awaiting: true,
    round: -1,
    truncated: false,
  };
}

/**
 * Paseo adapter: one connection with two owned directory subscriptions,
 * agents and workspaces. The SDK restores both after a reconnect and
 * delivers a fresh snapshot on each, which is reconciled against the local
 * directories. Snapshots and updates of both are applied strictly in
 * arrival order through one queue, and nothing is applied or reported
 * after `close()`.
 *
 * Freshness: data is fresh only when both subscriptions have applied a
 * snapshot of the current connection round. A round starts with every
 * disconnect the link poll sees, and also when a subscription receives a
 * second snapshot within one round: that is a reconnect the poll missed, so
 * the other subscription must deliver its snapshot too.
 */
export class AgentFeed {
  readonly directory = new AgentDirectory();
  readonly workspaces = new WorkspaceDirectory();

  private readonly client: AgentFeedClient;
  private readonly listener: AgentFeedListener;
  private readonly options: Required<Omit<AgentFeedOptions, "scheduler">>;
  private readonly scheduler: IntervalScheduler;
  /** The host's project list (P1); started after the first directory snapshots. */
  private readonly projectSync: ProjectDirectorySync;
  private readonly agentStream = newStream("agent_update");
  private readonly workspaceStream = newStream("workspace_update");
  private link: LinkState = { kind: "idle" };
  private everConnected = false;
  /** Counts transitions into "connected"; see connectionEpoch. */
  private connectedEpoch = 0;
  private round = 0;
  private lastEmittedStale = false;
  private failureValue: AgentFeedErrorCode | null = null;
  private serverIdValue: string | null = null;
  private poll: { cancel(): void } | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** The bounded host lookup of a resync in progress; close() cancels it. */
  private resyncWait: Deadline<string> | null = null;
  private started = false;
  private closed = false;
  /** The one cleanup every close() call waits for. */
  private closing: Promise<FeedCloseOutcome> | null = null;
  private firstSnapshot: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(
    client: AgentFeedClient,
    listener: AgentFeedListener = {},
    options: AgentFeedOptions = {},
  ) {
    const pageLimit = options.pageLimit ?? MAX_PAGE_LIMIT;
    if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_PAGE_LIMIT) {
      throw new RangeError(`pageLimit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
    }
    this.client = client;
    this.listener = listener;
    this.options = {
      includeArchived: options.includeArchived ?? false,
      includeBackground: options.includeBackground ?? false,
      pageLimit,
      linkPollIntervalMs: options.linkPollIntervalMs ?? DEFAULT_LINK_POLL_INTERVAL_MS,
      resyncHostTimeoutMs: options.resyncHostTimeoutMs ?? RESYNC_HOST_TIMEOUT_MS,
    };
    this.scheduler = options.scheduler ?? systemScheduler;
    this.projectSync = new ProjectDirectorySync({
      client,
      onChange: () => {
        this.notify(() => this.listener.onProjectsChange?.());
      },
      warn: (code) => {
        this.warn(code);
      },
    });
  }

  /**
   * The host's projects (P1): from the project list and its updates only,
   * never from workspaces. Not current unless its status is "ready".
   */
  get projects(): ProjectsState {
    return this.projectSync.state;
  }

  /** Explicit Retry of an unavailable, not live or unsynchronized project list. */
  retryProjects(): boolean {
    if (this.closed) return false;
    return this.projectSync.retry();
  }

  get linkState(): LinkState {
    return this.link;
  }

  /** Last known data stays visible but is flagged while it may be outdated. */
  get stale(): boolean {
    const notCurrent = (stream: Stream): boolean => stream.awaiting || stream.pending > 0;
    return (
      this.hasData &&
      (this.link.kind !== "connected" ||
        notCurrent(this.agentStream) ||
        notCurrent(this.workspaceStream) ||
        this.failureValue !== null)
    );
  }

  /**
   * Changes on every connection the feed knows of: each time the link
   * becomes connected, and when a second snapshot in one round reveals a
   * reconnect the link poll missed. A request can be tied to it, so an
   * answer from an earlier connection is recognized.
   */
  get connectionEpoch(): number {
    return this.connectedEpoch;
  }

  get serverId(): string | null {
    return this.serverIdValue;
  }

  /** True when the last agent snapshot reported more agents than one page. */
  get truncated(): boolean {
    return this.agentStream.truncated;
  }

  /** True when the last workspace snapshot reported more than one page. */
  get workspacesTruncated(): boolean {
    return this.workspaceStream.truncated;
  }

  /**
   * Set once the feed failed terminally (a subscription failure or an invalid
   * first snapshot); it then ignores further events. Recreate it to recover.
   */
  get failure(): AgentFeedErrorCode | null {
    return this.failureValue;
  }

  /** Agent directory snapshots applied: the initial one plus one per reconnect. */
  get snapshotsApplied(): number {
    return this.agentStream.applied;
  }

  /** Workspace directory snapshots applied. */
  get workspaceSnapshotsApplied(): number {
    return this.workspaceStream.applied;
  }

  agents(): AgentRecord[] {
    return this.directory.list();
  }

  workspaceList(): WorkspaceRecord[] {
    return this.workspaces.list();
  }

  /**
   * Both first snapshots are applied. Until then the data is partial: one
   * directory may already hold entries, but nothing should be shown as
   * current from it.
   */
  get ready(): boolean {
    return this.agentStream.applied > 0 && this.workspaceStream.applied > 0;
  }

  /** Some data is held; it is stale while either directory is not current. */
  private get hasData(): boolean {
    return this.agentStream.applied > 0 || this.workspaceStream.applied > 0;
  }

  /**
   * Connects, subscribes to both directories and resolves after the first
   * snapshot of each is applied. While the daemon is unreachable the SDK
   * keeps retrying, so callers bound this with their own deadline
   * (FeedRecovery does). Call `close()` afterwards in every case, including
   * when this rejects; it releases whatever was subscribed.
   */
  async start(): Promise<void> {
    // Checked before any timer, promise or connection is created.
    if (this.closed) throw new AgentFeedError("closed");
    if (this.started) throw new AgentFeedError("already_started");
    this.started = true;
    this.poll = this.scheduler.every(this.options.linkPollIntervalMs, () => {
      this.pollLink();
    });
    this.pollLink();

    const firstSnapshots = new Promise<void>((resolve, reject) => {
      this.firstSnapshot = { resolve, reject };
    });
    // Awaited below; this only prevents an unhandled rejection if start()
    // already failed earlier (e.g. connect rejected) and nobody awaits it.
    firstSnapshots.catch(() => undefined);

    // Underlying errors are replaced by stable codes; their messages may
    // contain URLs, credentials or paths and are never passed on.
    try {
      await this.client.connect();
    } catch {
      if (this.isClosed()) throw new AgentFeedError("closed");
      this.pollLink();
      throw new AgentFeedError(this.link.kind === "auth_failed" ? "auth_failed" : "connect_failed");
    }
    if (this.isClosed()) throw new AgentFeedError("closed");
    this.pollLink();
    const serverId = await this.fetchServerId().catch(() => null);
    if (this.isClosed()) throw new AgentFeedError("closed");
    if (serverId === null) throw new AgentFeedError("host_identity_failed");
    this.serverIdValue = serverId;

    const background = this.options.includeBackground ? { includeBackground: true } : {};
    await this.subscribe(this.agentStream, () =>
      this.client.agents.list({
        subscribe: {},
        page: { limit: this.options.pageLimit },
        ...background,
        ...(this.options.includeArchived ? { filter: { includeArchived: true } } : {}),
      }),
    );
    await this.subscribe(this.workspaceStream, () =>
      this.client.workspaces.list({
        subscribe: {},
        page: { limit: this.options.pageLimit },
        ...background,
      }),
    );
    await firstSnapshots;
    // Projects follow once the directories are in; their failure never fails
    // the feed. The host is known here (read at start, kept by resyncs).
    this.projectSync.start(this.serverIdValue);
  }

  /** Lists with a subscription and registers this feed's observer on it. */
  private async subscribe(
    stream: Stream,
    list: () => Promise<{ readonly subscription: FeedSubscription }>,
  ): Promise<void> {
    // close() may have run while the previous subscription was set up.
    if (this.isClosed()) throw new AgentFeedError("closed");
    const listed = await list().catch(() => null);
    if (this.isClosed()) {
      // close() already finished; a failing late release must not turn the
      // lifecycle result into a raw error, so the result stays "closed".
      await listed?.subscription.release().catch(() => undefined);
      throw new AgentFeedError("closed");
    }
    if (listed === null) throw new AgentFeedError("subscribe_failed");
    // Assigned first, so close() releases it even if registration throws.
    stream.subscription = listed.subscription;
    try {
      stream.unsubscribe = listed.subscription.subscribe({
        snapshot: (value) => {
          this.receiveSnapshot(stream, value);
        },
        update: (message) => {
          this.enqueue(() => {
            this.applyUpdate(stream, message);
          });
        },
        error: () => {
          this.fail("subscription_failed");
        },
      });
    } catch {
      // The SDK throws here, e.g. for an observation released meanwhile.
      throw new AgentFeedError(this.isClosed() ? "closed" : "subscribe_failed");
    }
  }

  /**
   * Stops polling, releases both subscriptions and closes the connection.
   * Every step is attempted even if an earlier one fails; the outcome tells
   * the subscriptions apart from the client (FeedCloseOutcome), without the
   * underlying errors.
   */
  close(): Promise<FeedCloseOutcome> {
    // Every caller, before, during or after the cleanup, waits for the same
    // one and gets the same outcome.
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  /**
   * Synchronously stops events first (as before), then releases both
   * subscriptions and closes the client, in that order. Failures of
   * unsubscribe, release, client.close and the state getter become the
   * outcome, never a raw error.
   */
  private async closeOnce(): Promise<FeedCloseOutcome> {
    this.closed = true;
    this.poll?.cancel();
    this.poll = null;
    this.resyncWait?.cancel();
    this.resyncWait = null;
    this.firstSnapshot?.reject(new AgentFeedError("closed"));
    this.firstSnapshot = null;

    let subscriptions: FeedCloseOutcome["subscriptions"] = "released";
    for (const stream of [this.agentStream, this.workspaceStream]) {
      const unsubscribe = stream.unsubscribe;
      stream.unsubscribe = null;
      try {
        unsubscribe?.();
      } catch {
        subscriptions = "failed";
      }
      const subscription = stream.subscription;
      stream.subscription = null;
      try {
        await subscription?.release();
      } catch {
        subscriptions = "failed";
      }
    }
    if (!(await this.projectSync.close())) subscriptions = "failed";
    let client: FeedCloseOutcome["client"];
    try {
      await this.client.close();
      client = this.clientDisposed() ? "closed" : "failed";
    } catch {
      // Conservative: a rejected close is unconfirmed even if the state
      // says disposed (0.15.4 may dispose in `finally` after an API error).
      client = "failed";
    }
    return { subscriptions, client };
  }

  /** The public state says disposed; a throwing getter is not a yes. */
  private clientDisposed(): boolean {
    try {
      return this.client.getConnectionState().status === "disposed";
    } catch {
      return false;
    }
  }

  /**
   * One public `providers.listUsage()` request on this feed's connection,
   * so usage needs no second connection owner. The caller bounds it with a
   * deadline and checks the host identity itself; the payload is unchecked.
   */
  listUsage(): Promise<unknown> {
    if (this.closed) return Promise.reject(new AgentFeedError("closed"));
    return this.client.providers.listUsage();
  }

  /** Re-reads the flag after an await; `close()` may have run meanwhile. */
  private isClosed(): boolean {
    return this.closed;
  }

  private async fetchServerId(): Promise<string> {
    const directory = await this.client.hosts.list();
    // The host boundary for server identity (protocol 0.15.4: a string). It
    // qualifies every key, so it must be non-empty, well-formed text.
    const serverId: unknown = directory.self.serverId;
    if (typeof serverId !== "string" || serverId.trim().length === 0 || !isWellFormed(serverId)) {
      throw new AgentFeedError("host_identity_failed");
    }
    return serverId;
  }

  /** Host identity for a resync snapshot, bounded so the queue never hangs. */
  private async resyncServerId(): Promise<string> {
    const wait = within(this.fetchServerId(), this.options.resyncHostTimeoutMs, this.scheduler);
    this.resyncWait = wait;
    const result = await wait.settled;
    if (this.resyncWait === wait) this.resyncWait = null;
    if (result.kind !== "value") throw new AgentFeedError("host_identity_failed");
    return result.value;
  }

  private enqueue(operation: () => void | Promise<void>): void {
    this.queue = this.queue
      .then(async () => {
        if (!this.closed && this.failureValue === null) await operation();
      })
      .catch(() => {
        this.warn("internal_error");
      });
  }

  private other(stream: Stream): Stream {
    return stream === this.agentStream ? this.workspaceStream : this.agentStream;
  }

  private receiveSnapshot(stream: Stream, value: unknown): void {
    if (this.closed || this.failureValue !== null) return;
    if (stream.round === this.round) {
      // A second snapshot in one round: a reconnect the poll did not see.
      this.round += 1;
      this.connectedEpoch += 1;
      this.other(stream).awaiting = true;
    }
    stream.round = this.round;
    // Marked on receipt, not when applied: until this snapshot is applied
    // the current data must not be presented as fresh.
    stream.awaiting = true;
    stream.pending += 1;
    const round = this.round;
    this.pollLink();
    this.enqueue(() => this.processSnapshot(stream, value, round));
  }

  private async processSnapshot(stream: Stream, snapshot: unknown, round: number): Promise<void> {
    let applied = false;
    try {
      applied =
        stream === this.agentStream
          ? await this.applyAgentSnapshot(snapshot)
          : await this.applyWorkspaceSnapshot(snapshot);
    } catch {
      this.warn("resync_failed");
    } finally {
      stream.pending -= 1;
      if (!this.isClosed()) {
        if (!applied && stream.applied === 0) {
          // Without a usable first snapshot there is no data to keep; waiting
          // would look like a healthy empty directory, so this is terminal.
          this.fail("initial_snapshot_invalid");
        } else if (applied && round === this.round) {
          // A snapshot of an older round leaves the stream awaiting.
          stream.awaiting = false;
        }
        this.resolveFirstSnapshots();
        this.pollLink();
      }
    }
  }

  private resolveFirstSnapshots(): void {
    if (this.agentStream.applied > 0 && this.workspaceStream.applied > 0) {
      this.firstSnapshot?.resolve();
      this.firstSnapshot = null;
    }
  }

  /**
   * Server identity for a snapshot. The first snapshot of each subscription
   * uses the identity read at start; later ones re-read it, since a reconnect
   * may reach a different daemon on the same URL. When it changed, the other
   * directory holds the old host's data: it is cleared and must deliver its
   * own snapshot before the data counts as fresh.
   */
  private async snapshotServerId(stream: Stream): Promise<string | null> {
    const serverId = stream.applied === 0 ? this.serverIdValue : await this.resyncServerId();
    if (serverId === null || this.isClosed()) return null;
    if (this.serverIdValue !== null && serverId !== this.serverIdValue) {
      this.warn("server_changed");
      this.projectSync.hostChanged(serverId);
      const other = this.other(stream);
      other.awaiting = true;
      if (other === this.agentStream) {
        for (const change of this.directory.replaceAll([])) {
          this.notify(() => this.listener.onChange?.(change));
        }
      } else {
        for (const change of this.workspaces.replaceAll([])) {
          this.notify(() => this.listener.onWorkspaceChange?.(change));
        }
      }
    }
    this.serverIdValue = serverId;
    return serverId;
  }

  /** Returns true only when the snapshot replaced the agent directory. */
  private async applyAgentSnapshot(snapshot: unknown): Promise<boolean> {
    const shape = readSnapshotShape(snapshot);
    if (!shape) {
      this.warn("snapshot_invalid");
      return false;
    }
    const serverId = await this.snapshotServerId(this.agentStream);
    if (serverId === null) return false;

    const records: AgentRecord[] = [];
    let skipped = 0;
    for (const entry of shape.entries) {
      const parsed = parseDirectoryEntry(serverId, entry);
      if (parsed.ok) records.push(parsed.value);
      else {
        skipped += 1;
        this.warn("entry_skipped", parsed.error);
      }
    }
    this.agentStream.truncated = shape.hasMore;
    if (shape.hasMore) this.warn("page_truncated");

    const changes = this.directory.replaceAll(records);
    this.agentStream.applied += 1;
    const info = { serverId, count: records.length, truncated: shape.hasMore, skipped };
    this.notify(() => this.listener.onSnapshot?.(changes, info));
    return true;
  }

  /** Returns true only when the snapshot replaced the workspace directory. */
  private async applyWorkspaceSnapshot(snapshot: unknown): Promise<boolean> {
    const shape = readSnapshotShape(snapshot);
    if (!shape) {
      this.warn("workspace_snapshot_invalid");
      return false;
    }
    const serverId = await this.snapshotServerId(this.workspaceStream);
    if (serverId === null) return false;

    const records: WorkspaceRecord[] = [];
    let skipped = 0;
    for (const entry of shape.entries) {
      const parsed = parseWorkspace(serverId, entry);
      if (parsed.ok) records.push(parsed.value);
      else {
        skipped += 1;
        this.warn("workspace_entry_skipped", parsed.error);
      }
    }
    this.workspaceStream.truncated = shape.hasMore;
    if (shape.hasMore) this.warn("workspace_page_truncated");

    const changes = this.workspaces.replaceAll(records);
    this.workspaceStream.applied += 1;
    const info = { serverId, count: records.length, truncated: shape.hasMore, skipped };
    this.notify(() => this.listener.onWorkspaceSnapshot?.(changes, info));
    return true;
  }

  private applyUpdate(stream: Stream, message: unknown): void {
    const payload = readUpdatePayload(message, stream.updateType);
    if (payload === undefined) return;
    const serverId = this.serverIdValue;
    if (serverId === null) return;
    if (stream === this.agentStream) this.applyAgentUpdate(serverId, payload);
    else this.applyWorkspaceUpdate(serverId, payload);
  }

  private applyAgentUpdate(serverId: string, payload: unknown): void {
    const parsed = parseAgentUpdate(serverId, payload);
    if (!parsed.ok) {
      this.warn("update_ignored", parsed.error);
      return;
    }
    const update = parsed.value;
    const change =
      update.kind === "upsert"
        ? this.directory.upsert(update.record, { preserveProject: !update.projectProvided })
        : this.directory.remove({ serverId, agentId: update.agentId });
    if (change) this.notify(() => this.listener.onChange?.(change));
  }

  private applyWorkspaceUpdate(serverId: string, payload: unknown): void {
    const parsed = parseWorkspaceUpdate(serverId, payload);
    if (!parsed.ok) {
      this.warn("workspace_update_ignored", parsed.error);
      return;
    }
    const update = parsed.value;
    const change =
      update.kind === "upsert"
        ? this.workspaces.upsert(update.record)
        : this.workspaces.remove({ serverId, workspaceId: update.workspaceId });
    if (change) this.notify(() => this.listener.onWorkspaceChange?.(change));
  }

  private fail(code: "subscription_failed" | "initial_snapshot_invalid"): void {
    if (this.closed || this.failureValue !== null) return;
    const error = new AgentFeedError(code);
    this.failureValue = error.code;
    this.notify(() => this.listener.onFailure?.(error));
    this.firstSnapshot?.reject(error);
    this.firstSnapshot = null;
    this.pollLink(true);
  }

  /** Emits when the displayed connection kind or the stale flag changes. */
  private pollLink(force = false): void {
    if (this.closed) return;
    const next = toLinkState(this.client.getConnectionState(), this.everConnected);
    if (next.kind === "connected") this.everConnected = true;
    const kindChanged = !sameLinkState(this.link, next);
    if (next.kind === "connected" && this.link.kind !== "connected") this.connectedEpoch += 1;
    if (kindChanged && next.kind !== "connected" && this.hasData) {
      // A disconnect starts a new round: both directories need a snapshot.
      this.round += 1;
      this.agentStream.awaiting = true;
      this.workspaceStream.awaiting = true;
    }
    this.link = next;
    const stale = this.stale;
    if (force || kindChanged || stale !== this.lastEmittedStale) {
      this.lastEmittedStale = stale;
      this.notify(() => this.listener.onLinkState?.(next, stale));
    }
  }

  private warn(code: FeedWarningCode, detail?: WarningDetail): void {
    if (this.closed) return;
    try {
      this.listener.onWarning?.(feedWarning(code, detail));
    } catch {
      // A failing warning sink must not break the feed or recurse.
    }
  }

  /** Listener errors are reported as warnings, never thrown into timers or the SDK. */
  private notify(call: () => void): void {
    if (this.closed) return;
    try {
      call();
    } catch {
      this.warn("listener_failed");
    }
  }
}
