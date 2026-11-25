import { projectKey, type ProjectRecord } from "../workspaces/project-model.ts";
import type { FeedSubscription } from "./agent-feed.ts";
import type { FeedWarningCode } from "./feed-diagnostics.ts";
import { parseProjectList, parseProjectUpdate, type ProjectUpdate } from "./project-parser.ts";
import { isRecord } from "./unknown-value.ts";

/**
 * The project list of one feed (P1), from the
 * one authority the public API offers: `projects.list()` (all projects of
 * the host, empty ones included) plus the `project.update` session event,
 * subscribed through the public `observeEvents`. Workspaces never create,
 * rename or remove projects here.
 *
 * Ordering (protocol 0.15.4 DirectorySyncMetadata): the list carries a
 * `generation` and the `headSeq` it includes; each update carries its
 * `generation` and `seq`. Within one generation a seq only grows, so an
 * update at or below the last applied seq is old or a duplicate and is
 * dropped. Seqs need not be consecutive: no gap is assumed from a jump. An
 * update of another generation, or without a position, cannot be ordered:
 * the list is read again (one request at a time, coalesced, and at most
 * MAX_SYNC_REFRESHES in a row before the list is unavailable until Retry).
 *
 * The event subscription is set up first; updates that arrive before the
 * list are buffered (bounded) and applied after it by the same rules. Every
 * activation of the subscription (the first one and each one after a
 * reconnect, when updates may have been missed), a host change and an
 * explicit Retry start a new epoch: results and callbacks of an older epoch
 * are dropped. A daemon without a sync position gives a list that cannot be
 * kept current: it is shown as not current and updates are ignored.
 */

/** Updates kept while the list is read; more means reading it again. */
export const MAX_BUFFERED_PROJECT_UPDATES = 256;
/** List reads in a row caused by unorderable updates before giving up. */
export const MAX_SYNC_REFRESHES = 3;

export type ProjectsStatus =
  /** No list yet for this host or connection. */
  | "loading"
  /** The daemon's list, kept current by ordered updates. */
  | "ready"
  /** Reading the list again; the projects shown are the last known. */
  | "refreshing"
  /** The update subscription failed: the list is a snapshot, not current. */
  | "not_live"
  /** The daemon sent no sync position: the list cannot be kept current. */
  | "unsynchronized"
  /** The list could not be read or brought in sync; Retry may help. */
  | "unavailable";

export interface ProjectsState {
  readonly status: ProjectsStatus;
  /** The last known projects of the current host, unordered. */
  readonly projects: readonly ProjectRecord[];
  /** True only for "ready": a selection may rely on these projects. */
  readonly current: boolean;
}

/** The parts of the client the project list uses. */
export interface ProjectSyncClient {
  observeEvents(events: ["project.update"]): FeedSubscription;
  readonly projects: { list(options: ProjectListRequest): Promise<unknown> };
}

/**
 * The list request. The request's `sync` cursor is optional in the
 * @getpaseo/client and protocol 0.15.4; the daemon handler read from the
 * installed Paseo app 0.17.4 (handleProjectListRequest) adds the sync
 * position (`generation`, `headSeq`) only when the request has a `sync`
 * field, and an empty one (no cursor) answers with a full snapshot. The
 * running daemon's version was not checked.
 */
export interface ProjectListRequest {
  readonly sync: { readonly generation?: string; readonly afterSeq?: number };
}

/** Always without a cursor: every read is the whole list with its position. */
const LIST_WITH_POSITION: ProjectListRequest = Object.freeze({ sync: Object.freeze({}) });

export interface ProjectSyncDeps {
  readonly client: ProjectSyncClient;
  /** Called after the state changed; never after close(). */
  readonly onChange: () => void;
  /** Fixed codes only. */
  readonly warn: (code: FeedWarningCode) => void;
}

export class ProjectDirectorySync {
  private readonly deps: ProjectSyncDeps;
  private serverId: string | null = null;
  private status: ProjectsStatus = "loading";
  private readonly projects = new Map<string, ProjectRecord>();
  /** Results and callbacks of an older epoch are dropped. */
  private epoch = 0;
  private subscription: FeedSubscription | null = null;
  private unsubscribe: (() => void) | null = null;
  private subscriptionFailed = false;
  /** Generation and last applied seq; null without an ordered list. */
  private position: { generation: string; lastSeq: number } | null = null;
  /** Whether the list of this epoch was applied; until then updates are buffered. */
  private listed = false;
  private buffer: ProjectUpdate[] = [];
  /** The list must be read again once it is in: too many updates, or an unreadable one. */
  private resyncAfterList = false;
  private listing = false;
  private listAgain = false;
  private refreshes = 0;
  private started = false;
  private closed = false;
  private closing: Promise<boolean> | null = null;
  /** Releases started and not yet settled; close() waits for them. */
  private readonly releases = new Set<Promise<void>>();
  /** An unsubscribe or release failed at some point; close() reports it. */
  private cleanupFailed = false;

  /** Creating it subscribes to and reads nothing. */
  constructor(deps: ProjectSyncDeps) {
    this.deps = deps;
  }

  get state(): ProjectsState {
    return {
      status: this.status,
      projects: [...this.projects.values()],
      current: this.status === "ready",
    };
  }

  /** Subscribes to updates for `serverId`; the list is read once subscribed. */
  start(serverId: string): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.serverId = serverId;
    this.subscribe();
  }

  /** The feed reached another daemon: the old projects are gone. */
  hostChanged(serverId: string): void {
    if (this.closed || serverId === this.serverId) return;
    this.serverId = serverId;
    this.projects.clear();
    this.restart("loading");
  }

  /**
   * Explicit Retry of a list that is unavailable, not live or not synced:
   * subscribes again if the subscription failed, else reads the list again.
   * False when there is nothing to retry.
   */
  retry(): boolean {
    if (this.closed || !this.started) return false;
    if (
      this.status !== "unavailable" &&
      this.status !== "not_live" &&
      this.status !== "unsynchronized"
    ) {
      return false;
    }
    this.refreshes = 0;
    if (this.subscriptionFailed) {
      this.releaseSubscription();
      this.subscriptionFailed = false;
      this.setStatus(this.projects.size > 0 ? "refreshing" : "loading");
      this.subscribe();
      return true;
    }
    this.restart(this.projects.size > 0 ? "refreshing" : "loading");
    return true;
  }

  /**
   * Stops updates and waits for every release started so far (also those
   * of a failed subscription or a Retry). True only when every unsubscribe
   * and release succeeded. Every call shares the same one outcome.
   */
  close(): Promise<boolean> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<boolean> {
    this.closed = true;
    this.epoch += 1;
    this.releaseSubscription();
    await Promise.all([...this.releases]);
    return !this.cleanupFailed;
  }

  private subscribe(): void {
    let subscription: FeedSubscription;
    try {
      subscription = this.deps.client.observeEvents(["project.update"]);
    } catch {
      this.onSubscriptionFailed();
      return;
    }
    this.subscription = subscription;
    try {
      this.unsubscribe = subscription.subscribe({
        // The subscription is active (first time or after a reconnect):
        // updates may have been missed, so the list is read again.
        snapshot: () => {
          if (this.subscription === subscription) this.onActivated();
        },
        update: (message) => {
          if (this.subscription === subscription) this.onUpdate(message);
        },
        error: () => {
          if (this.subscription === subscription) this.onSubscriptionFailed();
        },
      });
    } catch {
      this.onSubscriptionFailed();
    }
  }

  /**
   * Stops and releases the current subscription. The release is tracked
   * until it settles, so close() waits for it and reports a failure; only
   * the outcome is kept, never the subscription.
   */
  private releaseSubscription(): void {
    const unsubscribe = this.unsubscribe;
    const subscription = this.subscription;
    this.unsubscribe = null;
    this.subscription = null;
    try {
      unsubscribe?.();
    } catch {
      this.releaseFailed();
    }
    if (subscription === null) return;
    let released: Promise<void>;
    try {
      released = subscription.release();
    } catch {
      released = Promise.reject(new Error("release threw"));
    }
    const tracked: Promise<void> = released.then(
      () => {
        this.releases.delete(tracked);
      },
      () => {
        this.releases.delete(tracked);
        this.releaseFailed();
      },
    );
    this.releases.add(tracked);
  }

  private releaseFailed(): void {
    if (!this.cleanupFailed) this.deps.warn("project_release_failed");
    this.cleanupFailed = true;
  }

  private onActivated(): void {
    if (this.closed) return;
    this.subscriptionFailed = false;
    this.restart(this.projects.size > 0 ? "refreshing" : "loading");
  }

  private onSubscriptionFailed(): void {
    if (this.closed) return;
    this.deps.warn("project_subscription_failed");
    this.subscriptionFailed = true;
    this.releaseSubscription();
    if (this.listed && this.status !== "unavailable") {
      // The list stays, but nothing keeps it current any more.
      this.setStatus("not_live");
      return;
    }
    // Without updates, one list read still shows the projects, not current.
    this.restart(this.projects.size > 0 ? "refreshing" : "loading");
  }

  /** A new epoch: buffered updates and the position are dropped, the list is read. */
  private restart(status: ProjectsStatus): void {
    this.epoch += 1;
    this.position = null;
    this.listed = false;
    this.buffer = [];
    this.resyncAfterList = false;
    this.setStatus(status);
    this.requestList();
  }

  /** One list read at a time; a request while one runs reads once more after it. */
  private requestList(): void {
    if (this.closed) return;
    if (this.listing) {
      this.listAgain = true;
      return;
    }
    const epoch = this.epoch;
    const serverId = this.serverId;
    if (serverId === null) return;
    this.listing = true;
    let request: Promise<unknown>;
    try {
      request = this.deps.client.projects.list(LIST_WITH_POSITION);
    } catch {
      request = Promise.reject(new Error("list threw"));
    }
    request
      .then(
        (payload) => {
          this.onList(epoch, serverId, payload);
        },
        () => {
          this.onListFailed(epoch);
        },
      )
      .finally(() => {
        this.listing = false;
        if (this.listAgain && !this.closed) {
          this.listAgain = false;
          this.requestList();
        }
      })
      .catch(() => undefined);
  }

  /** A newer epoch queued its own read (restart → requestList); this result is dropped. */
  private isStale(epoch: number): boolean {
    return this.closed || epoch !== this.epoch;
  }

  private onListFailed(epoch: number): void {
    if (this.isStale(epoch)) return;
    this.deps.warn("project_list_failed");
    this.setStatus("unavailable");
  }

  private onList(epoch: number, serverId: string, payload: unknown): void {
    if (this.isStale(epoch) || serverId !== this.serverId) return;
    const list = parseProjectList(serverId, payload);
    if (list === null) {
      this.deps.warn("project_list_invalid");
      this.setStatus("unavailable");
      return;
    }
    if (list.skipped > 0) {
      // A list missing an entry is never presented as the complete list.
      this.deps.warn("project_entry_skipped");
      this.deps.warn("project_list_invalid");
      this.setStatus("unavailable");
      return;
    }
    this.projects.clear();
    for (const project of list.projects) this.projects.set(projectKey(project.address), project);
    this.listed = true;
    const buffered = this.buffer;
    const resyncNeeded = this.resyncAfterList;
    this.buffer = [];
    this.resyncAfterList = false;
    if (list.sync === null) {
      // Unordered updates could bring back an old name: none are applied.
      this.deps.warn("project_sync_missing");
      this.position = null;
      this.setStatus(this.subscriptionFailed ? "not_live" : "unsynchronized");
      return;
    }
    this.position = { generation: list.sync.generation, lastSeq: list.sync.headSeq };
    if (this.subscriptionFailed) {
      this.setStatus("not_live");
      return;
    }
    if (resyncNeeded) {
      this.resync();
      return;
    }
    for (const update of buffered) {
      if (!this.applyOrdered(update)) return;
    }
    // The refresh count is reset only by an applied, ordered update (or
    // Retry), so a daemon whose updates never fit the list ends unavailable.
    this.setStatus("ready");
  }

  private onUpdate(message: unknown): void {
    if (this.closed || this.serverId === null) return;
    if (!isRecord(message) || message["type"] !== "project.update") return;
    const update = parseProjectUpdate(this.serverId, message["payload"]);
    if (update === null) {
      // A project.update the plugin cannot read may have been a rename or a
      // removal: the list is not current any more and is read again.
      this.deps.warn("project_update_ignored");
      if (!this.listed) this.resyncAfterList = true;
      else if (this.status === "ready") this.resync();
      return;
    }
    if (!this.listed) {
      if (this.buffer.length < MAX_BUFFERED_PROJECT_UPDATES) this.buffer.push(update);
      else this.resyncAfterList = true;
      return;
    }
    // Without an ordered position (no sync, or not live) updates are ignored.
    if (this.position === null || this.status !== "ready") return;
    if (this.applyOrdered(update)) this.deps.onChange();
  }

  /**
   * Applies one update in order; false when it could not be ordered and the
   * list is read again instead.
   */
  private applyOrdered(update: ProjectUpdate): boolean {
    const position = this.position;
    if (position === null) return false;
    const at = update.position;
    if (at?.generation !== position.generation) {
      this.resync();
      return false;
    }
    // Old or duplicate: within a generation a seq only grows.
    if (at.headSeq <= position.lastSeq) return true;
    position.lastSeq = at.headSeq;
    if (update.kind === "upsert") {
      this.projects.set(projectKey(update.project.address), update.project);
    } else if (this.serverId !== null) {
      this.projects.delete(projectKey({ serverId: this.serverId, projectId: update.projectId }));
    }
    this.refreshes = 0;
    return true;
  }

  /** The list must be read again; bounded so it cannot loop forever. */
  private resync(): void {
    this.refreshes += 1;
    if (this.refreshes > MAX_SYNC_REFRESHES) {
      this.deps.warn("project_sync_failed");
      this.epoch += 1;
      this.position = null;
      this.listed = true;
      this.setStatus("unavailable");
      return;
    }
    this.restart(this.projects.size > 0 ? "refreshing" : "loading");
  }

  private setStatus(status: ProjectsStatus): void {
    this.status = status;
    if (!this.closed) this.deps.onChange();
  }
}
