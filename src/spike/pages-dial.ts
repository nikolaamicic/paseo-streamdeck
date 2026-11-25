import type { DialResult, StripText } from "../navigation/navigation.ts";
import { StripRenderer } from "./strip-renderer.ts";

/**
 * The Agent pages dials (M11b2b1), moved from plugin.ts unchanged: each
 * visible dial's serialized strip, appear and disappear, turning and
 * pressing. Each controller owns its own dials; the SDK action class only
 * checks the SDK kind (isDial) and calls it. Nothing here imports the
 * Stream Deck SDK.
 */

/** What an appearing Pages dial action instance gives the controller. */
export interface PagesDialHandle {
  readonly id: string;
  readonly deviceId: string;
  setFeedback(text: StripText): Promise<void>;
}

/** The action instance of a turn or press. */
export interface PagesDialInput {
  readonly id: string;
  showAlert(): Promise<void>;
}

/** The Navigation methods the Pages dial uses. */
export interface PagesNavigation {
  useDevice(deviceId: string): void;
  rotatePages(deviceId: string, ticks: number): DialResult;
  pressPages(deviceId: string): DialResult;
  pagesStrip(deviceId: string): StripText;
}

export interface PagesDialDeps {
  readonly navigation: PagesNavigation;
  /** After shutdown began no dial appears. */
  readonly shutdownStarted: () => boolean;
  /** A full redraw (plugin.ts renderAll); it calls showStrips. */
  readonly renderAll: () => void;
  /** Fixed codes only. */
  readonly log: { info(message: string): void; warn(message: string): void };
}

interface PagesDial {
  readonly deviceId: string;
  readonly strip: StripRenderer;
}

export class PagesDials {
  private readonly deps: PagesDialDeps;
  private readonly dials = new Map<string, PagesDial>();

  constructor(deps: PagesDialDeps) {
    this.deps = deps;
  }

  appeared(handle: PagesDialHandle): void {
    if (this.deps.shutdownStarted()) return;
    // A reappearing dial gets a fresh strip; the old one sends nothing more.
    this.dials.get(handle.id)?.strip.dispose();
    this.dials.set(handle.id, {
      deviceId: handle.deviceId,
      strip: new StripRenderer(
        (text) => handle.setFeedback(text),
        () => {
          this.deps.log.warn("pages dial: feedback_failed");
        },
      ),
    });
    this.deps.navigation.useDevice(handle.deviceId);
    this.deps.renderAll();
  }

  disappeared(contextId: string): void {
    this.dials.get(contextId)?.strip.dispose();
    this.dials.delete(contextId);
  }

  /** Pages never wrap; an alert only when the layout is not current. */
  async rotated(handle: PagesDialInput, ticks: number): Promise<void> {
    const dial = this.dials.get(handle.id);
    if (dial === undefined) return;
    const result = this.deps.navigation.rotatePages(dial.deviceId, ticks);
    if (result === "moved") this.deps.renderAll();
    else if (result === "not_current") await handle.showAlert();
  }

  /** Re-sorts the keys by priority and returns to page 1 (explicit refresh). */
  async pressed(handle: PagesDialInput): Promise<void> {
    const dial = this.dials.get(handle.id);
    if (dial === undefined) return;
    const result = this.deps.navigation.pressPages(dial.deviceId);
    this.deps.renderAll();
    if (result === "refreshed") return;
    this.deps.log.info(`pages dial: press_${result}`);
    await handle.showAlert();
  }

  /**
   * Redraw step: every dial shows its device's Pages strip. Settles when
   * the send runs these calls started finished; a strip queued behind a
   * send in flight settles at once (that run sends it). Never rejects;
   * renderAll ignores it.
   */
  async showStrips(): Promise<void> {
    await Promise.all(
      [...this.dials.values()].map((dial) =>
        dial.strip.show({ text: this.deps.navigation.pagesStrip(dial.deviceId), preview: null }),
      ),
    );
  }

  /** Shutdown: every strip stops sending and is forgotten. */
  dispose(): void {
    for (const dial of this.dials.values()) dial.strip.dispose();
    this.dials.clear();
  }
}
