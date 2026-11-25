import type { ShownStrip, StripText } from "../navigation/navigation.ts";

/**
 * A strip payload and the preview it presents. The Workspace dial sends
 * StripText; the Usage dial its own payload, always without a preview.
 */
export interface StripViewOf<T> {
  readonly text: T;
  readonly preview: string | null;
}

function sameView<T>(a: StripViewOf<T>, b: StripViewOf<T>): boolean {
  return a.preview === b.preview && JSON.stringify(a.text) === JSON.stringify(b.text);
}

/**
 * Serialized strip updates for one dial instance, like KeyRenderer for keys:
 * at most one setFeedback in flight, a newer view replaces one not yet sent,
 * unchanged views are skipped. A resolved setFeedback only means Stream Deck
 * accepted the request, not that the strip shows it. After a failure what
 * the strip shows is unknown; after dispose() nothing more is sent and a
 * late completion changes nothing.
 */
export class StripRenderer<T = StripText> {
  private readonly send: (text: T) => Promise<void>;
  private readonly onError: () => void;
  private sent: StripViewOf<T> | null = null;
  private inFlight: StripViewOf<T> | null = null;
  private next: StripViewOf<T> | null = null;
  private disposed = false;

  constructor(send: (text: T) => Promise<void>, onError: () => void) {
    this.send = send;
    this.onError = onError;
  }

  /**
   * The last strip Stream Deck accepted, or null when none was accepted or a
   * pending update would change its preview. A press must match this, so it
   * never acts on what was not sent.
   */
  get shown(): ShownStrip | null {
    const sent = this.sent;
    if (sent === null) return null;
    const changing = [this.inFlight, this.next].some(
      (view) => view !== null && view.preview !== sent.preview,
    );
    return changing ? null : { preview: sent.preview };
  }

  dispose(): void {
    this.disposed = true;
    this.next = null;
    this.sent = null;
  }

  /** Re-reads the flag after an await; `dispose()` may have run meanwhile. */
  private isActive(): boolean {
    return !this.disposed;
  }

  async show(view: StripViewOf<T>): Promise<void> {
    if (this.disposed) return;
    const latest = this.next ?? this.inFlight ?? this.sent;
    if (latest !== null && sameView(latest, view)) return;
    if (this.inFlight !== null) {
      this.next = view;
      return;
    }
    let current: StripViewOf<T> | null = view;
    while (current !== null && this.isActive()) {
      this.inFlight = current;
      this.next = null;
      try {
        await this.send(current.text);
        if (this.isActive()) this.sent = current;
      } catch {
        this.sent = null;
        if (this.isActive()) this.onError();
      } finally {
        this.inFlight = null;
      }
      current = this.next;
    }
  }
}
