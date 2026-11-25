import streamDeck, {
  SingletonAction,
  type DialDownEvent,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type PropertyInspectorDidAppearEvent,
  type PropertyInspectorDidDisappearEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { randomUUID } from "node:crypto";
import { createPaseoClient } from "@getpaseo/client";
import { openAgent } from "../opener/open-agent.ts";
import { systemTimers } from "../paseo/deadline.ts";
import { paseoClientConfig } from "../paseo/sdk-logger.ts";
import { ACTION_IDS, REGISTRATION_ORDER, type ActionName } from "./action-ids.ts";
import { bootstrapPlugin } from "./bootstrap.ts";
import { createPluginRuntime } from "./plugin-runtime.ts";
import { readLegacyFile } from "../connection/legacy-file.ts";
import { sendInspectorView } from "./workspace-inspector.ts";
import { isConnectionMessage } from "../inspector/connection-protocol.ts";

/**
 * Paseo Control: the SDK entry point. Logs contain codes and the runtime
 * version only: no IDs, titles, paths or raw errors. K2 recovery: after a
 * terminal feed failure FeedRecovery retries every 30 s and the keys offer
 * Retry; an authentication failure waits for Retry. Ordinary disconnects are
 * handled by the SDK's reconnect.
 *
 * Five actions: the agent keys placed by the navigation, the Project dial
 * (its Property Inspector chooses the Start in, stored in the dial's action
 * settings), Agent pages, Usage and Attention (src/navigation/navigation.ts).
 * The separate E1 key action was removed at the user's request
 * (2026-11-25); its legacy file is still read for the daemon address.
 */

const log = streamDeck.logger;
log.setLevel("info");
log.info(`plugin start: node ${process.version}, ${process.platform}-${process.arch}`);

const runtime = createPluginRuntime({
  timers: systemTimers,
  readLegacyFile: () => readLegacyFile(),
  getGlobalSettings: () => streamDeck.settings.getGlobalSettings(),
  subscribeGlobalSettings: (listener) => {
    const subscription = streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
      listener(ev.settings);
    });
    return {
      dispose: () => {
        subscription[Symbol.dispose]();
      },
    };
  },
  // The SDK sends the whole object; resolving means handed to Stream Deck.
  setGlobalSettings: (settings) => streamDeck.settings.setGlobalSettings(settings),
  createClient: (daemonUrl, report) => createPaseoClient(paseoClientConfig(daemonUrl, report)),
  sendToInspector: (context, view) => sendInspectorView(streamDeck.ui, context, view),
  newChallenge: () => randomUUID(),
  sendConnectionMessage: (context, message) => {
    // A type check that the message is an SDK JSON payload as it is.
    const payload: Parameters<typeof streamDeck.ui.sendToPropertyInspector>[0] = message;
    return sendInspectorView(streamDeck.ui, context, payload);
  },
  open: (address) => openAgent(address),
  now: () => Date.now(),
  exit: () => {
    process.exit(0);
  },
  log,
});

/**
 * The SDK's JSON types live in @elgato/utils, which is not a direct
 * dependency; they are taken from the SDK's own signatures instead.
 */
type InspectorMessageEvent = SendToPluginEvent<
  Parameters<typeof streamDeck.ui.sendToPropertyInspector>[0],
  WillAppearEvent["payload"]["settings"]
>;

/**
 * Every action's Property Inspector speaks the connection protocol (C4a3):
 * its appearance opens a session, its disappearance ends it, and its
 * messages go to the runtime's connection port, which validates them.
 */
class InspectorAction extends SingletonAction {
  override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent): Promise<void> {
    await runtime.connection.inspectorShown(ev.action.id);
  }

  override onPropertyInspectorDidDisappear(ev: PropertyInspectorDidDisappearEvent): void {
    runtime.connection.inspectorHidden(ev.action.id);
  }

  override async onSendToPlugin(ev: InspectorMessageEvent): Promise<void> {
    await runtime.connection.inspectorMessage(ev.action.id, ev.payload);
  }
}

/** Keys that show the agents of the confirmed workspace, eight per page. */
class SlotKeyAction extends InspectorAction {
  override readonly manifestId = ACTION_IDS.slot;

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isKey() || ev.action.isInMultiAction()) return;
    const action = ev.action;
    runtime.keys.slotAppeared({
      id: action.id,
      deviceId: action.device.id,
      coordinates: action.coordinates,
      setImage: (image) => action.setImage(image),
      setTitle: (title) => action.setTitle(title),
      showAlert: () => action.showAlert(),
      showOk: () => action.showOk(),
    });
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    runtime.keys.slotDisappeared(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    await runtime.keys.slotPressed(ev.action);
  }
}

/** Pages through the workspace keys; never wraps. */
class PagesDialAction extends InspectorAction {
  override readonly manifestId = ACTION_IDS.pages;

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isDial()) return;
    const action = ev.action;
    runtime.pages.appeared({
      id: action.id,
      deviceId: action.device.id,
      setFeedback: (text) => action.setFeedback(text),
    });
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    runtime.pages.disappeared(ev.action.id);
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    await runtime.pages.rotated(ev.action, ev.payload.ticks);
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    await runtime.pages.pressed(ev.action);
  }
}

/** Account usage: turn through the reported items, press for the first. */
class UsageDialAction extends InspectorAction {
  override readonly manifestId = ACTION_IDS.usage;

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isDial()) return;
    const action = ev.action;
    runtime.usage.appeared({
      id: action.id,
      setFeedback: (payload) => action.setFeedback(payload),
    });
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    runtime.usage.disappeared(ev.action.id);
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    await runtime.usage.rotated(ev.action, ev.payload.ticks);
  }

  override onDialDown(ev: DialDownEvent): void {
    runtime.usage.pressed(ev.action.id);
  }
}

/**
 * Attention: turn through agents that need the user, press to open the
 * shown one in Paseo. Never answers, approves or sends anything.
 */
class AttentionDialAction extends InspectorAction {
  override readonly manifestId = ACTION_IDS.attention;

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isDial()) return;
    const action = ev.action;
    runtime.attention.appeared({
      id: action.id,
      setFeedback: (payload) => action.setFeedback(payload),
    });
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    runtime.attention.disappeared(ev.action.id);
  }

  override onDialRotate(ev: DialRotateEvent): void {
    runtime.attention.rotated(ev.action.id, ev.payload.ticks);
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    await runtime.attention.pressed(ev.action);
  }
}

class WorkspaceDial extends InspectorAction {
  override readonly manifestId = ACTION_IDS.workspace;

  override onWillAppear(ev: WillAppearEvent): void {
    if (!ev.action.isDial()) return;
    const action = ev.action;
    runtime.workspace.appeared(
      {
        id: action.id,
        deviceId: action.device.id,
        setSettings: (settings) => action.setSettings(settings),
        setFeedback: (feedback) => action.setFeedback(feedback),
      },
      ev.payload.settings,
    );
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    runtime.workspace.disappeared(ev.action.id);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent): void {
    runtime.workspace.settingsReceived(ev.action.id, ev.payload.settings);
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    await runtime.workspace.rotated(ev.action, ev.payload.ticks);
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    await runtime.workspace.pressed(ev.action);
  }

  /** The connection session and the Start in view; separate message types. */
  override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent): Promise<void> {
    await Promise.all([
      super.onPropertyInspectorDidAppear(ev),
      runtime.workspace.inspectorShown(ev.action.id),
    ]);
  }

  /** A connection message, also a malformed one, never reaches the Start in parser. */
  override async onSendToPlugin(ev: InspectorMessageEvent): Promise<void> {
    if (isConnectionMessage(ev.payload)) {
      await super.onSendToPlugin(ev);
      return;
    }
    await runtime.workspace.inspectorMessage(ev.action.id, ev.payload);
  }
}

/** One class per action; a missing one is a type error. */
const ACTION_CLASSES: Readonly<Record<ActionName, () => SingletonAction>> = {
  workspace: () => new WorkspaceDial(),
  slot: () => new SlotKeyAction(),
  pages: () => new PagesDialAction(),
  usage: () => new UsageDialAction(),
  attention: () => new AttentionDialAction(),
};

await bootstrapPlugin({
  onceSignal: (signal, handler) => {
    process.once(signal, handler);
  },
  runShutdown: () => runtime.shutdown(),
  order: REGISTRATION_ORDER,
  createAction: (name) => ACTION_CLASSES[name](),
  registerAction: (action) => {
    streamDeck.actions.registerAction(action);
  },
  connect: () => streamDeck.connect(),
  startFeed: () => runtime.start(),
  logStartFailed: () => {
    log.error("plugin start failed");
  },
});
