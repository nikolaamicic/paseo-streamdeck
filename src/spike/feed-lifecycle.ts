import {
  chooseConnection,
  interpretLegacyFile,
  readSavedConnection,
  type ConnectionBlock,
  type ConnectionChoice,
  type ConnectionSource,
  type LegacyFile,
  type LegacyFileRead,
  type SavedConnection,
} from "../connection/connection-model.ts";
import type { JsonObject } from "../connection/connection-save.ts";
import { ConnectionSaver, type SaveOutcome } from "../connection/connection-saver.ts";
import {
  GlobalSettingsReader,
  type ReadStatus,
  type SettingsReaderDeps,
} from "../connection/settings-reader.ts";
import { AgentFeed, type AgentFeedClient, type AgentFeedOptions } from "../paseo/agent-feed.ts";
import { within, type Deadline, type Timers } from "../paseo/deadline.ts";
import { FeedRecovery, type RecoveryEvent, type StopOutcome } from "../paseo/feed-recovery.ts";
import type { LinkState } from "../paseo/link-state.ts";
import type { SdkLogLevel } from "../paseo/sdk-logger.ts";
import type { ProjectionSource } from "./feed-projections.ts";

/**
 * The feed lifecycle of the plugin (M11b1, connection sources C3a3): the
 * one owner of the Paseo connection. It reads the global settings
 * (GlobalSettingsReader) and the legacy E1 file once, chooses the address
 * saved > legacy > default and starts
 * the one FeedRecovery that owns the feed and its client. The E1 target is
 * read from the legacy file separately and never blocks the connection.
 *
 * A new valid address from the settings switches at runtime (C3b2): the
 * old owner is detached from the views at once (a generation guards all of
 * its callbacks) and stopped; a new client is created only after that stop
 * confirmed its client closed (SDK disposal, not a closed socket) or never
 * created. A failed or late close blocks the switch (switch_blocked); a
 * choice that is not valid keeps the active connection. Views show only
 * the address actually in use.
 *
 * Creating it does nothing external. Logs are fixed codes only: no raw
 * errors, settings values, file contents or URLs.
 */

/** Fixed-code log lines. */
export interface LifecycleLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface FeedLifecycleDeps {
  /** Reads the legacy E1 file, read-only and bounded (legacy-file.ts). */
  readonly readLegacyFile: () => Promise<LegacyFileRead>;
  /** streamDeck.settings, through plugin.ts; only after the SDK connected. */
  readonly getGlobalSettings: SettingsReaderDeps["getGlobalSettings"];
  readonly subscribeGlobalSettings: SettingsReaderDeps["subscribe"];
  /**
   * A fresh client for one feed attempt. `report` receives only SDK log
   * levels (paseoClientConfig's level-only logger), never raw objects.
   */
  readonly createClient: (
    daemonUrl: string,
    report: (level: SdkLogLevel) => void,
  ) => AgentFeedClient;
  readonly timers: Timers;
  /** AgentFeed options; plugin.ts passes none, as before. */
  readonly feedOptions?: AgentFeedOptions;
  /** A full redraw (plugin.ts renderAll). */
  readonly onChange: () => void;
  /** After shutdown began nothing starts. */
  readonly shutdownStarted: () => boolean;
  /** streamDeck.settings.setGlobalSettings, through plugin.ts; replaces the whole object. */
  readonly setGlobalSettings: (settings: JsonObject) => Promise<void>;
  readonly log: LifecycleLog;
}

/**
 * Bound for closing the old connection before a new address is used (C3b2):
 * a chosen user-facing limit for a local, interactive change, as the
 * connect and settings read limits. Not a measured close time. The stop is
 * not cancelled by it; a late confirmed close still unblocks.
 */
export const SWITCH_CLOSE_TIMEOUT_MS = 5_000;

/** The connection as the views see it. */
export type ConnectionView =
  | { readonly kind: "loading" }
  | { readonly kind: "blocked"; readonly reason: ConnectionBlock }
  /** The old connection is being closed before a new address is used. */
  | { readonly kind: "switching" }
  /**
   * The old connection's close was not confirmed (failed, or not yet after
   * SWITCH_CLOSE_TIMEOUT_MS): no new client until it is; restart the plugin.
   */
  | { readonly kind: "switch_blocked" }
  /** The address the feed was actually started with. */
  | { readonly kind: "active"; readonly daemonUrl: string; readonly source: ConnectionSource };

/**
 * Read-only facts for a status view (C4a2), each kept apart: never derive
 * one from another. A fresh object per call; nothing in it is live.
 */
export interface ConnectionFacts {
  /** What the views show; `active` only means a feed owner runs on it. */
  readonly view: ConnectionView;
  /** The source choice from what is known now; may differ from `view`. */
  readonly requested: ConnectionChoice | { readonly kind: "loading" };
  /** The saved connection in the known global settings. */
  readonly saved: SavedConnection | { readonly kind: "loading" };
  /** The address this plugin sent, while it is still what is known; unconfirmed. */
  readonly sent: string | null;
  /** The address of a Save the SDK is sending now; not known or active yet. */
  readonly sending: string | null;
  /** The feed's own link state; "none" without a feed. Connected only from here. */
  readonly link: LinkState["kind"] | "none";
  /** The latest global settings read attempt (C4a4b); what is known stays apart. */
  readonly settingsRead: ReadStatus;
}

export interface FeedLifecycle {
  /** The connection and the recovery owner, for the views. */
  source(): ProjectionSource;
  /** What is saved, sent, sending, requested, shown and linked; read-only. */
  facts(): ConnectionFacts;
  /**
   * Saves a daemon address (C4a2): one Save owner over the one reader. A
   * sent write becomes the reader's known state, and the existing choice
   * and switch rules apply it; Save never starts, stops or retries a
   * connection itself and never bypasses switch_blocked. "stopped" after
   * shutdown began.
   */
  save(daemonUrl: unknown): Promise<SaveOutcome>;
  /**
   * Reads the global settings again (C4a4b, plan 4.6): once per bound
   * inspector opening. Never writes; a failed or timed-out read keeps what
   * is known, and a changed source goes through the usual choice and switch.
   */
  refreshSettings(): void;
  /**
   * One explicit Retry: the recovery owner's, when a feed exists; otherwise
   * a new read of unavailable global settings (the reader reuses a read in
   * flight). False when there is nothing to retry.
   */
  retryNow(): boolean;
  /** Reads the sources and, once one is valid, starts the feed. */
  start(): Promise<void>;
  /**
   * Shutdown: disposes the settings reader, cancels a switch deadline and
   * waits for the recovery owner and any close already under way.
   */
  stop(): Promise<void>;
}

/** What the global settings say about the saved connection right now. */
function savedConnection(reader: GlobalSettingsReader): SavedConnection | "loading" {
  const { known, read } = reader.state;
  if (known.kind === "loaded")
    return readSavedConnection({ kind: "loaded", settings: known.settings });
  if (known.kind === "malformed") return { kind: "settings_malformed" };
  return read === "timed_out" || read === "failed"
    ? readSavedConnection({ kind: "unavailable" })
    : "loading";
}

export function createFeedLifecycle(deps: FeedLifecycleDeps): FeedLifecycle {
  const { log } = deps;
  let legacy: LegacyFile | null = null;
  /** The one live recovery owner, of the active address; null while none runs. */
  let recovery: FeedRecovery<AgentFeed> | null = null;
  let active: Extract<ConnectionView, { kind: "active" }> | null = null;
  /**
   * Rises before an old owner is stopped; every callback of an owner carries
   * the generation it was made in and does nothing once it is old.
   */
  let generation = 0;
  /** The old owner's stop while it is being closed, with its deadline. */
  let closing: {
    readonly stop: Promise<StopOutcome>;
    readonly deadline: Deadline<StopOutcome>;
  } | null = null;
  /** "timeout" may still turn into a confirmed close; "failed" stays until restart. */
  let switchBlocked: "timeout" | "failed" | null = null;
  let lastLogged = "";
  /** Set by stop(); with the plugin's shutdown flag, nothing starts after it. */
  let stopped = false;
  const ended = (): boolean => stopped || deps.shutdownStarted();

  const reader = new GlobalSettingsReader({
    getGlobalSettings: () => deps.getGlobalSettings(),
    subscribe: (listener) => deps.subscribeGlobalSettings(listener),
    timers: deps.timers,
    onChange: () => {
      evaluate();
      deps.onChange();
    },
  });

  /**
   * The one Save owner, over the same reader: an accepted write becomes the
   * reader's known state, whose onChange runs evaluate() as for any change.
   */
  const saver = new ConnectionSaver({
    reader,
    active: () => (active === null ? null : { daemonUrl: active.daemonUrl, source: active.source }),
    setGlobalSettings: (settings) => deps.setGlobalSettings(settings),
  });

  /** The source choice from what is known now; "connect" is not yet applied. */
  function choose(): ConnectionChoice | { readonly kind: "loading" } {
    const saved = savedConnection(reader);
    if (saved === "loading") return { kind: "loading" };
    // A saved, malformed or unavailable state decides without the legacy file.
    if (saved.kind !== "absent") return chooseConnection(saved, { kind: "absent" });
    // The legacy file as read at start; it is not read again.
    if (legacy === null) return { kind: "loading" };
    return chooseConnection(saved, legacy.connection);
  }

  /**
   * What the views show: the address a feed actually runs on; while the old
   * one closes, switching; after an unconfirmed close, switch_blocked;
   * otherwise the choice, where a valid one not yet applied is loading. A
   * new address is never shown as active before it is used.
   */
  function connection(): ConnectionView {
    if (active !== null) return active;
    if (switchBlocked !== null) return { kind: "switch_blocked" };
    if (closing !== null) return { kind: "switching" };
    const choice = choose();
    return choice.kind === "blocked" ? choice : { kind: "loading" };
  }

  function logOnce(line: string): void {
    if (line === lastLogged) return;
    lastLogged = line;
    log.info(line);
  }

  function logChoice(choice: ConnectionChoice | { readonly kind: "loading" }): void {
    if (choice.kind === "connect") logOnce(`connection: ${choice.source}`);
    else if (choice.kind === "blocked") logOnce(`connection blocked: ${choice.reason}`);
  }

  /**
   * One step towards the current choice. Synchronous, so the decision and
   * its effect (a start reserved, a stop begun) happen before anything can
   * run again; repeated changes never make a second owner or client.
   */
  function evaluate(): void {
    if (ended()) return;
    const choice = choose();
    logChoice(choice);
    if (active !== null && recovery !== null) {
      // A choice that is not valid keeps the active connection.
      if (choice.kind !== "connect") return;
      if (choice.daemonUrl === active.daemonUrl) {
        // The same address: never a restart; only the source may change.
        if (choice.source !== active.source) active = { ...active, source: choice.source };
        return;
      }
      beginSwitch(recovery);
      return;
    }
    // While the old owner closes, or after an unconfirmed close, nothing starts.
    if (closing !== null || switchBlocked !== null) return;
    if (choice.kind === "connect") startFeed(choice.daemonUrl, choice.source);
  }

  /** Stops the old owner; its views are gone at once and nothing new starts yet. */
  function beginSwitch(old: FeedRecovery<AgentFeed>): void {
    // Before stop(): even its synchronous callbacks are already old.
    generation += 1;
    recovery = null;
    active = null;
    logOnce("connection switch: closing");
    const stop = old.stop();
    const deadline = within(stop, SWITCH_CLOSE_TIMEOUT_MS, deps.timers);
    const current = { stop, deadline };
    closing = current;
    void deadline.settled.then((result) => {
      if (closing !== current || ended() || result.kind !== "timeout") return;
      switchBlocked = "timeout";
      logOnce("connection switch blocked: timeout");
      deps.onChange();
    });
    void stop.then(
      (outcome) => {
        finishSwitch(current, outcome.client === "failed" ? "failed" : "closed");
      },
      () => {
        // stop() does not reject; if it ever did, the close is unconfirmed.
        finishSwitch(current, "failed");
      },
    );
    deps.onChange();
  }

  /** The old owner's stop finished, maybe after its deadline. */
  function finishSwitch(current: NonNullable<typeof closing>, outcome: "closed" | "failed"): void {
    if (closing !== current) return;
    closing = null;
    current.deadline.cancel();
    if (ended()) return;
    if (outcome === "failed") {
      // Never start past a client that was not confirmed disposed.
      switchBlocked = "failed";
      logOnce("connection switch blocked: failed");
      deps.onChange();
      return;
    }
    switchBlocked = null;
    // The newest valid request now, not the one that began the switch.
    evaluate();
    deps.onChange();
  }

  function startFeed(daemonUrl: string, source: ConnectionSource): void {
    active = { kind: "active", daemonUrl, source };
    const owner = generation;
    const current = (): boolean => owner === generation;
    const onChange = () => {
      if (current()) deps.onChange();
    };
    recovery = new FeedRecovery<AgentFeed>({
      // Every attempt gets a fresh client; the owner closes the old one first.
      createFeed: (onTerminalFailure) =>
        new AgentFeed(
          // The SDK's default logger prints raw objects; the safe one logs levels only.
          deps.createClient(daemonUrl, (level) => {
            if (!current()) return;
            if (level === "error") log.error("paseo client: error");
            else log.warn("paseo client: warning");
          }),
          {
            onLinkState: (state, stale) => {
              if (!current()) return;
              log.info(`link: ${state.kind}${stale ? " (stale)" : ""}`);
              deps.onChange();
            },
            onSnapshot: onChange,
            onChange,
            onWorkspaceSnapshot: onChange,
            onWorkspaceChange: onChange,
            // The project list (P1) drives the Project dial, keys and inspector.
            onProjectsChange: onChange,
            onWarning: (warning) => {
              if (current()) log.warn(`feed warning: ${warning.code}`);
            },
            onFailure: (error) => {
              onTerminalFailure(error.code);
              onChange();
            },
          },
          deps.feedOptions,
        ),
      timers: deps.timers,
      onChange,
      onEvent: (event) => {
        if (current()) logRecovery(event);
      },
    });
    recovery.start();
  }

  function logRecovery(event: RecoveryEvent): void {
    if (event.kind === "failed") log.error(`feed failed: ${event.error}`);
    else if (event.kind === "cleanup_failed") log.warn("feed cleanup failed");
    else log.info(`feed ${event.kind}`);
  }

  async function start(): Promise<void> {
    if (ended()) return;
    reader.start();
    const read = await deps.readLegacyFile();
    // After shutdown began the file's answer changes nothing.
    if (ended()) return;
    legacy = interpretLegacyFile(read);
    log.info(`legacy target: ${legacy.target.kind}`);
    evaluate();
    deps.onChange();
  }

  return {
    source: () => ({
      connection: connection(),
      recovery,
    }),
    facts: () => {
      const saved = savedConnection(reader);
      return {
        view: connection(),
        requested: choose(),
        saved: saved === "loading" ? { kind: "loading" } : saved,
        sent: saver.sent?.daemonUrl ?? null,
        sending: saver.sending,
        link: recovery?.feed?.linkState.kind ?? "none",
        settingsRead: reader.state.read,
      };
    },
    save: (daemonUrl) => (ended() ? Promise.resolve({ kind: "stopped" }) : saver.save(daemonUrl)),
    refreshSettings: () => {
      // The reader's own Retry: at most one SDK read in flight (one in
      // flight gets a new deadline), stale answers dropped by revision.
      if (!ended()) reader.retry();
    },
    retryNow: () => {
      if (recovery !== null) return recovery.retryNow();
      const view = connection();
      // Only unreadable settings can be retried here: the legacy file is
      // read once per start, a bad source needs a fix, and an unconfirmed
      // close needs a plugin restart, never a second owner.
      if (view.kind !== "blocked" || view.reason !== "settings_unavailable") return false;
      reader.retry();
      return true;
    },
    start,
    stop: async () => {
      stopped = true;
      // The saver first: a late SDK answer then changes nothing and starts nothing.
      saver.dispose();
      reader.dispose();
      const pending = closing;
      pending?.deadline.cancel();
      // Shutdown's own grace bounds both waits.
      await Promise.all([recovery?.stop(), pending?.stop]);
    },
  };
}
