import { startInSettings, type StartInSettings } from "../workspaces/start-in-settings.ts";
import type { WorkspaceDialContexts } from "../workspaces/workspace-dial-contexts.ts";
import type { ShownStrip, StripText, StripView } from "../navigation/navigation.ts";
import { choiceSourceOf, type ChoiceSource } from "../workspaces/project-selection.ts";
import { START_IN_ALL } from "../workspaces/start-in-settings.ts";
import type { Timers } from "../paseo/deadline.ts";
import { TextScroller } from "./footer-scroll.ts";
import { StripRenderer } from "./strip-renderer.ts";
import { stripFrame, stripLanes } from "./strip-scroll.ts";
import {
  inspectorView,
  parseInspectorRequest,
  resolveInspectorChoice,
  type InspectorFacts,
  type InspectorView,
} from "./workspace-inspector.ts";

/** What the controller needs from one Project dial action instance. */
export interface DialHandle {
  readonly id: string;
  setSettings(settings: StartInSettings): Promise<void>;
  setFeedback(feedback: StripText): Promise<void>;
}

export interface WorkspaceDialsOptions {
  readonly contexts: WorkspaceDialContexts;
  /** Clock for scrolling long names on the strips. */
  readonly timers: Timers;
  facts(): InspectorFacts;
  /** What the dial's touch strip segment shows (the navigation's text, W7). */
  strip(contextId: string): StripView;
  /** Delivers a view to the inspector of `context` only if that inspector is open. */
  sendToInspector(context: string, view: InspectorView): Promise<void>;
  /**
   * Reads the project list again (the feed's retryProjects); false without
   * a feed or when the list cannot be retried now.
   */
  retryProjects(): boolean;
  /** Stable codes only, never payload values. */
  log(code: string): void;
}

const NOT_CURRENT = "Not saved: the project list is not current. Try again when it is.";
const NOT_LISTED = "Not saved: that project is no longer listed.";
const RETRYING = "Reading the project list again…";
const NO_RETRY = "Retry is not available right now.";
// The SDK's setSettings resolves once the settings are sent to Stream Deck;
// it does not confirm storage, so the messages claim no more than that.
const SENT = "Setting sent to Stream Deck.";
const NOT_SENT = "Could not send the setting to Stream Deck.";

/**
 * Connects Project dial instances, their inspectors and the Start in
 * contexts. Everything is per action context: an unknown or hidden context
 * is ignored, choices are validated against the current host and list
 * before anything is written, and writes of one context run one at a time.
 * A queued write runs only if the same dial instance is still visible, so it
 * never reaches a dial that disappeared or reappeared under the same context.
 * Each dial instance has its own StripRenderer, so a late completion of a
 * dial that disappeared never counts for its successor.
 */
interface DialStrip {
  readonly renderer: StripRenderer;
  readonly scroller: TextScroller;
  /** The full strip from the navigation, before scrolling. */
  base: StripView | null;
}

function disposeStrip(strip: DialStrip | undefined): void {
  strip?.scroller.dispose();
  strip?.renderer.dispose();
}

export class WorkspaceDials {
  private readonly options: WorkspaceDialsOptions;
  private readonly dials = new Map<string, DialHandle>();
  private readonly strips = new Map<string, DialStrip>();
  private readonly sentViews = new Map<string, string>();
  private readonly writes = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(options: WorkspaceDialsOptions) {
    this.options = options;
  }

  appear(dial: DialHandle, settings: unknown): void {
    if (this.disposed) return;
    const issue = this.options.contexts.appear(dial.id, settings);
    if (issue !== null) this.options.log(`start_in_settings_${issue}`);
    this.dials.set(dial.id, dial);
    disposeStrip(this.strips.get(dial.id));
    this.strips.set(dial.id, this.createStrip(dial));
    this.refreshOne(dial.id);
  }

  disappear(contextId: string): void {
    this.options.contexts.disappear(contextId);
    this.dials.delete(contextId);
    disposeStrip(this.strips.get(contextId));
    this.strips.delete(contextId);
    this.sentViews.delete(contextId);
  }

  /** Settings changed outside the plugin (Property Inspector or Stream Deck). */
  settingsReceived(contextId: string, settings: unknown): void {
    if (!this.dials.has(contextId)) return;
    const issue = this.options.contexts.settingsChanged(contextId, settings);
    if (issue !== null) this.options.log(`start_in_settings_${issue}`);
    this.refreshOne(contextId);
  }

  /** A message from an inspector page. */
  request(contextId: string, payload: unknown): Promise<void> {
    const dial = this.dials.get(contextId);
    if (dial === undefined) {
      this.options.log("inspector_unknown_context");
      return Promise.resolve();
    }
    const request = parseInspectorRequest(payload);
    if (request === null) {
      this.options.log("inspector_bad_message");
      return Promise.resolve();
    }
    // Phase markers for device checks: fixed codes, never values.
    this.options.log(`inspector_${request.kind}_received`);
    if (request.kind === "refresh") return this.sendView(contextId, null, true);
    if (request.kind === "retry_projects") {
      // Only the explicit button: never automatic, and nothing is written.
      const started = this.options.retryProjects();
      this.options.log(started ? "projects_retry_started" : "projects_retry_unavailable");
      return this.sendView(contextId, started ? RETRYING : NO_RETRY, true);
    }
    const previous = this.writes.get(contextId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await this.choose(dial, request.value);
      } finally {
        // Only the last queued write clears the entry.
        if (this.writes.get(contextId) === next) this.writes.delete(contextId);
      }
    });
    this.writes.set(contextId, next);
    return next;
  }

  /**
   * Shutdown: forgets every dial and context first, so queued writes are
   * dropped and nothing is sent or drawn during teardown.
   */
  dispose(): void {
    this.disposed = true;
    for (const contextId of this.dials.keys()) this.options.contexts.disappear(contextId);
    this.dials.clear();
    for (const strip of this.strips.values()) disposeStrip(strip);
    this.strips.clear();
    this.sentViews.clear();
  }

  /**
   * This dial's strip as last accepted by Stream Deck, or null (none,
   * pending or failed). A Project dial press may act only on this.
   */
  shownStrip(contextId: string): ShownStrip | null {
    return this.strips.get(contextId)?.renderer.shown ?? null;
  }

  /** Writes still queued or in flight, per context (for tests and diagnostics). */
  get pendingWrites(): number {
    return this.writes.size;
  }

  /**
   * An inspector became visible. Its own refresh request can arrive before
   * Stream Deck reports it visible and then finds no open inspector, so the
   * view is also sent from here; the page renders whichever arrives.
   */
  inspectorShown(contextId: string): Promise<void> {
    if (this.dials.has(contextId)) this.options.log("inspector_shown");
    return this.sendView(contextId, null, true);
  }

  /**
   * The feed changed: resolves the contexts against the current facts, then
   * redraws. For a caller that has not just synced the contexts itself.
   */
  refresh(): void {
    this.options.contexts.sync(this.choiceSource());
    this.redraw();
  }

  /**
   * Updates every visible dial and open inspector without resolving the
   * contexts. Only for a caller that synced them against the same facts
   * just before (plugin.ts renderAll, after Navigation.sync).
   */
  redraw(): void {
    for (const contextId of this.dials.keys()) this.refreshOne(contextId);
  }

  /** The dial is still this instance: not hidden, replaced or disposed. */
  private isCurrent(dial: DialHandle): boolean {
    return !this.disposed && this.dials.get(dial.id) === dial;
  }

  private async choose(dial: DialHandle, value: string): Promise<void> {
    if (!this.isCurrent(dial)) {
      this.options.log("inspector_choice_dropped");
      return;
    }
    const facts = this.options.facts();
    const result = resolveInspectorChoice(value, facts);
    if (!result.ok) {
      this.options.log(`inspector_choice_${result.reason}`);
      await this.sendView(
        dial.id,
        result.reason === "not_current" ? NOT_CURRENT : NOT_LISTED,
        true,
      );
      return;
    }
    // Fields of the stored settings the plugin does not know are kept.
    const settings = startInSettings(result.startIn, this.options.contexts.settings(dial.id));
    try {
      await dial.setSettings(settings);
    } catch {
      this.options.log("start_in_send_failed");
      if (this.isCurrent(dial)) await this.sendView(dial.id, NOT_SENT, true);
      return;
    }
    // A write already sent cannot be recalled, but its result belongs to
    // this instance only; a reappeared dial gets its settings with willAppear.
    this.options.log("start_in_sent");
    if (!this.isCurrent(dial)) return;
    this.options.contexts.settingsChanged(dial.id, settings);
    this.options.contexts.sync(this.choiceSource());
    this.refreshOne(dial.id, SENT);
  }

  private refreshOne(contextId: string, message: string | null = null): void {
    void this.updateFeedback(contextId);
    void this.sendView(contextId, message, message !== null);
  }

  private async updateFeedback(contextId: string): Promise<void> {
    const strip = this.strips.get(contextId);
    if (strip === undefined) return;
    const view = this.options.strip(contextId);
    strip.base = view;
    // Each lane restarts only when its own text changes.
    strip.scroller.show(stripLanes(view));
    await strip.renderer.show(stripFrame(view, strip.scroller.offsets));
  }

  /** A dial instance's strip: serialized sends and one scroll clock. */
  private createStrip(dial: DialHandle): DialStrip {
    const renderer = new StripRenderer(
      (text) => dial.setFeedback(text),
      () => {
        this.options.log("dial_feedback_failed");
      },
    );
    let strip: DialStrip | null = null;
    const scroller = new TextScroller({
      timers: this.options.timers,
      onFrame: (offsets) => {
        const base = strip?.base ?? null;
        if (base !== null) void renderer.show(stripFrame(base, offsets));
      },
    });
    strip = { renderer, scroller, base: null };
    return strip;
  }

  /** Sends the view; unchanged views are not resent unless forced. */
  private async sendView(contextId: string, message: string | null, force: boolean): Promise<void> {
    if (!this.dials.has(contextId)) return;
    const view = inspectorView(
      contextId,
      this.options.contexts.startIn(contextId) ?? START_IN_ALL,
      this.options.facts(),
      message,
    );
    const key = JSON.stringify(view);
    if (!force && this.sentViews.get(contextId) === key) return;
    this.sentViews.set(contextId, key);
    try {
      await this.options.sendToInspector(contextId, view);
    } catch {
      this.sentViews.delete(contextId);
      this.options.log("inspector_send_failed");
    }
  }

  private choiceSource(): ChoiceSource {
    return choiceSourceOf(this.options.facts());
  }
}
