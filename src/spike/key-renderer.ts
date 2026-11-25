import type { AgentAddress } from "../agents/agent-model.ts";
import { sameAddress } from "../agents/agent-model.ts";
import { sameKeyView, type KeyView } from "./key-view.ts";

/**
 * Draws a view on one key; resolves when Stream Deck accepted the request.
 * `isCurrent()` turns false once the renderer is disposed, so a draw with
 * several steps stops before writing to a key it no longer owns.
 */
export type DrawKey = (view: KeyView, isCurrent: () => boolean) => Promise<void>;

function sameIdentity(a: AgentAddress | null, b: AgentAddress | null): boolean {
  return a === null || b === null ? a === b : sameAddress(a, b);
}

/**
 * Serialized rendering for one key instance: at most one draw in flight,
 * newer views replace undrawn older ones, unchanged views are skipped. It
 * remembers the identity of the last completed draw. A resolved draw only
 * proves the request reached Stream Deck, not that the device shows it
 * (spec §7). After `dispose()` nothing more is drawn.
 */
export class KeyRenderer {
  private readonly draw: DrawKey;
  private drawn: KeyView | null = null;
  private inFlight: KeyView | null = null;
  private next: KeyView | null = null;
  private disposed = false;

  constructor(draw: DrawKey) {
    this.draw = draw;
  }

  /** Identity of the last completed draw. */
  get renderedIdentity(): AgentAddress | null {
    return this.drawn?.identity ?? null;
  }

  /** Whether the last completed draw offered Retry. */
  get renderedRetry(): boolean {
    return this.drawn?.retry ?? false;
  }

  /**
   * True while an in-flight or queued draw would change what a press does:
   * a different identity, or Retry appearing or disappearing.
   */
  get pressChangePending(): boolean {
    const shown = this.renderedIdentity;
    const retry = this.renderedRetry;
    return [this.inFlight, this.next].some(
      (view) => view !== null && (!sameIdentity(view.identity, shown) || view.retry !== retry),
    );
  }

  /** Stops drawing for a key that disappeared or got a new renderer. */
  dispose(): void {
    this.disposed = true;
    this.next = null;
    this.drawn = null;
  }

  /** Re-reads the flag after an await; `dispose()` may have run meanwhile. */
  private isActive(): boolean {
    return !this.disposed;
  }

  async show(view: KeyView): Promise<void> {
    if (this.disposed) return;
    const latest = this.next ?? this.inFlight ?? this.drawn;
    if (latest !== null && sameKeyView(latest, view)) return;
    if (this.inFlight !== null) {
      this.next = view;
      return;
    }
    let current: KeyView | null = view;
    while (current !== null && this.isActive()) {
      this.inFlight = current;
      this.next = null;
      try {
        await this.draw(current, () => this.isActive());
        if (this.isActive()) this.drawn = current;
      } catch {
        // Unknown what the key shows now; a press must not trust the old view.
        this.drawn = null;
      } finally {
        this.inFlight = null;
      }
      current = this.next;
    }
  }
}
