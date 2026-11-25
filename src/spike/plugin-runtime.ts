import type { AgentAddress } from "../agents/agent-model.ts";
import { Navigation, type NavigationFacts } from "../navigation/navigation.ts";
import type { OpenOutcome } from "../opener/open-agent.ts";
import type { IntervalScheduler } from "../paseo/agent-feed.ts";
import type { Timers } from "../paseo/deadline.ts";
import { UsagePoller } from "../usage/usage-poller.ts";
import { WorkspaceDialContexts } from "../workspaces/workspace-dial-contexts.ts";
import { AttentionDials } from "./attention-dial.ts";
import { AttentionDialEvents } from "./attention-dial-events.ts";
import type { SaveOutcome } from "../connection/connection-saver.ts";
import {
  createFeedLifecycle,
  type ConnectionFacts,
  type FeedLifecycleDeps,
  type LifecycleLog,
} from "./feed-lifecycle.ts";
import {
  attentionFacts,
  feedInputs as projectFeedInputs,
  inspectorFacts as projectInspectorFacts,
  navigationFacts as projectNavigationFacts,
  renderAllSteps,
  usageFacts,
  usageSource,
  type ProjectionSource,
} from "./feed-projections.ts";
import type { PluginMessage } from "../inspector/connection-protocol.ts";
import { ConnectionInspectors } from "./connection-inspector.ts";
import { KeyController } from "./key-controller.ts";
import { slotKeyView, type FeedInputs, type KeyView } from "./key-view.ts";
import { PagesDials } from "./pages-dial.ts";
import { createShutdown } from "./shutdown.ts";
import { UsageDials } from "./usage-dial.ts";
import { UsageDialEvents } from "./usage-dial-events.ts";
import { WorkspaceDials } from "./workspace-dial.ts";
import { WorkspaceDialEvents } from "./workspace-dial-events.ts";
import type { InspectorFacts, InspectorView } from "./workspace-inspector.ts";

/**
 * The plugin's runtime (M11b2c1), moved from plugin.ts unchanged: the feed
 * lifecycle, shutdown, navigation, the keys and dials, their event
 * controllers and the full redraw, declared in the same order with the
 * same callbacks. Every external effect comes in through deps; creating a
 * runtime reads no settings or file, creates no client, starts no timer and
 * logs nothing. Nothing here imports the Stream Deck SDK; plugin.ts keeps the
 * logger setup, the SDK action classes, their registration and bootstrap.
 */

export interface PluginRuntimeDeps {
  readonly timers: Timers;
  /** Reads the legacy E1 file, read-only and bounded. */
  readonly readLegacyFile: FeedLifecycleDeps["readLegacyFile"];
  /** streamDeck.settings.getGlobalSettings; called only after start(). */
  readonly getGlobalSettings: FeedLifecycleDeps["getGlobalSettings"];
  /** streamDeck.settings.onDidReceiveGlobalSettings, giving the settings. */
  readonly subscribeGlobalSettings: FeedLifecycleDeps["subscribeGlobalSettings"];
  /** streamDeck.settings.setGlobalSettings; called only by a Save. */
  readonly setGlobalSettings: FeedLifecycleDeps["setGlobalSettings"];
  readonly createClient: FeedLifecycleDeps["createClient"];
  /** Delivers a view to the inspector of `context` only if it is open. */
  readonly sendToInspector: (context: string, view: InspectorView) => Promise<void>;
  /** Delivers a connection message to the inspector of `context` only if it is open. */
  readonly sendConnectionMessage: (context: string, message: PluginMessage) => Promise<void>;
  /** A new inspector challenge (crypto.randomUUID); not a secret, only a correlation. */
  readonly newChallenge: () => string;
  readonly open: (address: AgentAddress) => Promise<OpenOutcome>;
  /** Wall clock for the Usage reset countdowns. */
  readonly now: () => number;
  /** Ends the process (the last shutdown step). */
  readonly exit: () => void;
  /** Fixed-code log lines. */
  readonly log: LifecycleLog;
  /**
   * The feed's link polling clock, for tests only. Without it the feed
   * uses its own system scheduler, as plugin.ts always did.
   */
  readonly feedScheduler?: IntervalScheduler;
}

/** What the SDK action classes call: the event ports, start and shutdown. */
export interface PluginRuntime {
  readonly keys: Pick<KeyController, "slotAppeared" | "slotDisappeared" | "slotPressed">;
  readonly pages: Pick<PagesDials, "appeared" | "disappeared" | "rotated" | "pressed">;
  readonly workspace: Pick<
    WorkspaceDialEvents,
    | "appeared"
    | "disappeared"
    | "settingsReceived"
    | "rotated"
    | "pressed"
    | "inspectorShown"
    | "inspectorMessage"
  >;
  readonly usage: Pick<UsageDialEvents, "appeared" | "disappeared" | "rotated" | "pressed">;
  readonly attention: Pick<AttentionDialEvents, "appeared" | "disappeared" | "rotated" | "pressed">;
  /**
   * The connection's Save and status (C4a2) and the inspector protocol of
   * every action (C4a3, connection-inspector.ts).
   */
  readonly connection: {
    /** Saves an unvalidated daemon address; "sent" never means stored. */
    save(daemonUrl: unknown): Promise<SaveOutcome>;
    /** A fresh read-only snapshot of the separate connection facts. */
    status(): ConnectionFacts;
    /** An action's inspector appeared: a new session, sent the status. */
    inspectorShown(contextId: string): Promise<void>;
    /** An action's inspector disappeared: answers for it are dropped. */
    inspectorHidden(contextId: string): void;
    /** A connection message from an action's inspector; unvalidated JSON. */
    inspectorMessage(contextId: string, payload: unknown): Promise<void>;
  };
  /**
   * Reads the global settings and the legacy E1 file and starts the feed
   * for the first valid source (bootstrap's startFeed, after connect).
   */
  start(): Promise<void>;
  /** Runs the shutdown once (bootstrap's runShutdown). */
  shutdown(): Promise<void>;
}

export function createPluginRuntime(deps: PluginRuntimeDeps): PluginRuntime {
  const log = deps.log;

  /**
   * The feed lifecycle (config, recovery, feed and client). Creating it does
   * nothing external; bootstrap's startFeed starts it. Its callbacks run only
   * after start(), when every module-level object below exists.
   */
  const feedLifecycle = createFeedLifecycle({
    readLegacyFile: () => deps.readLegacyFile(),
    getGlobalSettings: () => deps.getGlobalSettings(),
    subscribeGlobalSettings: (listener) => deps.subscribeGlobalSettings(listener),
    setGlobalSettings: (settings) => deps.setGlobalSettings(settings),
    createClient: (daemonUrl, report) => deps.createClient(daemonUrl, report),
    timers: deps.timers,
    // Only a test passes a scheduler; plugin.ts passes none, as before.
    ...(deps.feedScheduler === undefined ? {} : { feedOptions: { scheduler: deps.feedScheduler } }),
    onChange: () => {
      renderAll();
    },
    shutdownStarted: () => shutdown.started,
    log,
  });

  /**
   * Graceful cleanup on a terminating signal, the only hook available (see
   * shutdown.ts): keys stop drawing, then the owner closes feed and client.
   */
  const shutdown = createShutdown({
    disposeKeys: () => {
      connectionInspectors.dispose();
      workspaceDials.dispose();
      usageDials.dispose();
      usagePoller.dispose();
      attentionDials.dispose();
      keyController.dispose();
      pagesDials.dispose();
    },
    stopRecovery: () => feedLifecycle.stop(),
    exit: () => {
      deps.exit();
    },
    timers: deps.timers,
    onOutcome: (outcome) => {
      log.info(`shutdown: ${outcome}`);
    },
  });

  /** The current config and recovery owner, read fresh by every projection. */
  function projectionSource(): ProjectionSource {
    return feedLifecycle.source();
  }

  function feedInputs(): FeedInputs {
    return projectFeedInputs(projectionSource());
  }

  function navigationFacts(): NavigationFacts {
    return projectNavigationFacts(projectionSource());
  }

  function inspectorFacts(): InspectorFacts {
    return projectInspectorFacts(projectionSource());
  }

  const dialContexts = new WorkspaceDialContexts();
  const navigation = new Navigation(dialContexts, navigationFacts);

  const workspaceDials = new WorkspaceDials({
    contexts: dialContexts,
    timers: deps.timers,
    facts: inspectorFacts,
    strip: (contextId) => navigation.workspaceStrip(contextId),
    sendToInspector: (context, view) => deps.sendToInspector(context, view),
    retryProjects: () => projectionSource().recovery?.feed?.retryProjects() ?? false,
    log: (code) => {
      log.info(`workspace dial: ${code}`);
    },
  });

  /**
   * Account usage (U2): asked on the feed's own connection, only while a
   * Usage dial is visible. Nothing about it is logged except fixed codes.
   */
  const usagePoller = new UsagePoller({
    timers: deps.timers,
    source: () => usageSource(projectionSource()),
    onChange: () => {
      usageDials.refresh();
    },
  });

  const usageDials = new UsageDials({
    timers: deps.timers,
    state: () => usagePoller.state,
    facts: () => usageFacts(projectionSource()),
    now: () => deps.now(),
    log: (code) => {
      log.warn(`usage dial: ${code}`);
    },
  });

  /** Agent pages dials: page through the workspace keys of their device. */
  const pagesDials = new PagesDials({
    navigation,
    shutdownStarted: () => shutdown.started,
    renderAll: () => {
      renderAll();
    },
    log,
  });

  /** The Workspace dial's SDK events: registration, redraws and alerts. */
  const workspaceEvents = new WorkspaceDialEvents({
    navigation,
    dials: workspaceDials,
    shutdownStarted: () => shutdown.started,
    renderAll: () => {
      renderAll();
    },
    log: (message) => {
      log.info(message);
    },
  });

  /** The Usage dial's SDK events: the appear guard and the poller switch. */
  const usageEvents = new UsageDialEvents({
    dials: usageDials,
    poller: usagePoller,
    shutdownStarted: () => shutdown.started,
  });

  /**
   * Connection inspector sessions of every action (C4a3): status and Save
   * through the lifecycle's one Save owner; answers only the open session.
   */
  const connectionInspectors = new ConnectionInspectors({
    save: (daemonUrl) => saveConnection(daemonUrl),
    status: () => feedLifecycle.facts(),
    send: (context, message) => deps.sendConnectionMessage(context, message),
    newChallenge: () => deps.newChallenge(),
    refreshSettings: () => {
      feedLifecycle.refreshSettings();
    },
    log: (code) => {
      log.info(code);
    },
  });

  /**
   * The one Save path, for the port and every inspector: open inspectors get
   * a changed status once the Save has started (the address being sent) and
   * once it has finished (sent, or not). The reader's own callback redraws
   * while the Save is still settling, and a write of the active address
   * brings no later feed event, so these two pushes are needed.
   */
  function saveConnection(daemonUrl: unknown): Promise<SaveOutcome> {
    const saving = feedLifecycle.save(daemonUrl);
    connectionInspectors.refresh();
    return saving.then((outcome) => {
      connectionInspectors.refresh();
      return outcome;
    });
  }

  /** Attention (dial 4): the existing feed's agents, no requests of its own. */
  const attentionDials = new AttentionDials({
    timers: deps.timers,
    facts: () => attentionFacts(projectionSource()),
    log: (code) => {
      log.warn(`attention dial: ${code}`);
    },
  });

  /** The Attention dial's SDK events: the appear guard and the press flow. */
  const attentionEvents = new AttentionDialEvents({
    dials: attentionDials,
    shutdownStarted: () => shutdown.started,
    open: (address) => deps.open(address),
    log: (message) => {
      log.info(message);
    },
  });

  /** The view of a workspace key, from the navigation's placement for its slot. */
  function slotView(deviceId: string, slotIndex: number): KeyView {
    const state = navigation.slot(deviceId, slotIndex);
    const slot = state.kind === "agent" ? state.address : state.kind;
    return slotKeyView({
      ...feedInputs(),
      slot,
      dimmed: state.kind === "agent" && state.dimmed,
      record:
        state.kind === "agent"
          ? projectionSource().recovery?.feed?.directory.get(state.address)
          : undefined,
    });
  }

  function renderAll(): void {
    renderAllSteps({
      syncNavigation: () => {
        navigation.sync();
      },
      presentSlotKeys: () => {
        void keyController.presentSlotKeys();
      },
      showPagesStrips: () => {
        void pagesDials.showStrips();
      },
      // Navigation.sync above resolved the dial contexts against this feed.
      refreshWorkspaceDials: () => {
        workspaceDials.redraw();
      },
      syncUsage: () => {
        usagePoller.sync();
      },
      refreshUsageDials: () => {
        usageDials.refresh();
      },
      refreshAttentionDials: () => {
        attentionDials.refresh();
      },
    });
    // Open connection inspectors get the status only when it changed.
    connectionInspectors.refresh();
  }

  /** The agent keys (key-controller.ts). */
  const keyController = new KeyController({
    timers: deps.timers,
    shutdownStarted: () => shutdown.started,
    slotState: (deviceId, slotIndex) => navigation.slot(deviceId, slotIndex),
    slotView,
    useDevice: (deviceId) => {
      navigation.useDevice(deviceId);
    },
    renderAll: () => {
      renderAll();
    },
    isPresent: (address) => projectionSource().recovery?.feed?.directory.get(address) !== undefined,
    retryNow: () => feedLifecycle.retryNow(),
    open: (address) => deps.open(address),
    log: (message) => {
      log.info(message);
    },
  });

  return {
    keys: keyController,
    pages: pagesDials,
    workspace: workspaceEvents,
    usage: usageEvents,
    attention: attentionEvents,
    connection: {
      save: (daemonUrl) => saveConnection(daemonUrl),
      status: () => feedLifecycle.facts(),
      inspectorShown: (contextId) =>
        shutdown.started ? Promise.resolve() : connectionInspectors.shown(contextId),
      inspectorHidden: (contextId) => {
        connectionInspectors.hidden(contextId);
      },
      inspectorMessage: (contextId, payload) =>
        shutdown.started ? Promise.resolve() : connectionInspectors.message(contextId, payload),
    },
    start: () => feedLifecycle.start(),
    shutdown: () => shutdown.run(),
  };
}
