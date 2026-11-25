import {
  readStartIn,
  sameStartIn,
  type StartIn,
  type StartInSettingsIssue,
} from "./start-in-settings.ts";
import { ProjectChoice, type ChoiceSource } from "./project-selection.ts";

interface DialContext {
  readonly startIn: StartIn;
  readonly choice: ProjectChoice;
  /** The settings as last received; a write keeps their unknown fields. */
  settings: unknown;
}

/**
 * Start in and the current selection of each Project dial (the action
 * whose UUID is still `…workspace`, so existing profiles keep their dials),
 * keyed by its Stream Deck action context (action.id). Contexts never share
 * state, so dials in different profiles keep their own values; there is no
 * global last-writer-wins.
 *
 * Lifecycle (spike/workspace-dial.ts): appear() from willAppear with
 * ev.payload.settings, settingsChanged() from onDidReceiveSettings or a
 * saved inspector choice, disappear() from willDisappear, sync() after feed
 * changes. Only appear() creates a context.
 */
export class WorkspaceDialContexts {
  private readonly contexts = new Map<string, DialContext>();
  /**
   * Contexts that disappeared (another device page or profile). Their
   * choice comes back when the same dial reappears with the same Start in,
   * so a confirmed project survives page and profile switches until the
   * plugin restarts. They take no events.
   */
  private readonly hidden = new Map<string, DialContext>();

  /** A dial context appeared with its stored settings; creates or refreshes it. */
  appear(contextId: string, settings: unknown): StartInSettingsIssue | null {
    const read = readStartIn(settings);
    const kept = this.hidden.get(contextId);
    this.hidden.delete(contextId);
    if (kept !== undefined && sameStartIn(kept.startIn, read.startIn)) {
      kept.settings = settings;
      this.contexts.set(contextId, kept);
    } else {
      this.apply(contextId, read.startIn, settings);
    }
    return read.issue;
  }

  /**
   * Its settings changed through the Property Inspector. A different Start in
   * applies at once (an explicit user action); the same value keeps the
   * current selection. Ignored for a context that has not appeared or has
   * disappeared: it is not revived, and its stored settings arrive with its
   * next willAppear. Returns the settings' issue code either way, for logging.
   */
  settingsChanged(contextId: string, settings: unknown): StartInSettingsIssue | null {
    const read = readStartIn(settings);
    if (this.contexts.has(contextId)) this.apply(contextId, read.startIn, settings);
    return read.issue;
  }

  /** The context disappeared; it takes no events until it appears again. */
  disappear(contextId: string): void {
    const context = this.contexts.get(contextId);
    if (context !== undefined) this.hidden.set(contextId, context);
    this.contexts.delete(contextId);
  }

  /** The current choice of a context; rotation and press go through it. */
  choice(contextId: string): ProjectChoice | undefined {
    return this.contexts.get(contextId)?.choice;
  }

  startIn(contextId: string): StartIn | undefined {
    return this.contexts.get(contextId)?.startIn;
  }

  /** The settings last received for a visible context (unknown fields included). */
  settings(contextId: string): unknown {
    return this.contexts.get(contextId)?.settings;
  }

  /** Resolves every context against the feed; returns the contexts that changed. */
  sync(source: ChoiceSource): string[] {
    const changed: string[] = [];
    for (const [contextId, context] of this.contexts) {
      if (context.choice.sync(source)) changed.push(contextId);
    }
    return changed;
  }

  private apply(contextId: string, startIn: StartIn, settings: unknown): void {
    const known = this.contexts.get(contextId);
    if (known !== undefined && sameStartIn(known.startIn, startIn)) {
      known.settings = settings;
      return;
    }
    this.contexts.set(contextId, { startIn, choice: new ProjectChoice(startIn), settings });
  }
}
