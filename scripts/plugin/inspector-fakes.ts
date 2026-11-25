/**
 * Minimal stand-ins for the browser APIs the inspector pages use (C4b): an
 * element with text, value, disabled and hidden state and listeners, a
 * document that finds elements by ID, and a WebSocket the test drives. No
 * DOM library: only what workspace.js and connection.js touch. Used by the
 * inspector tests and by the smoke check of the built bundle.
 */

export class FakeElement {
  readonly id: string;
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  children: FakeElement[] = [];
  private readonly listeners = new Map<string, (() => void)[]>();

  constructor(id: string) {
    this.id = id;
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  /** Runs the listeners of `type`, as a user action would. */
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }
}

/** The IDs both inspector pages use, Start in and the connection section. */
export const PAGE_IDS = [
  "start-in",
  "status",
  "notice",
  "projects-retry",
  "message",
  "connection-status",
  "connection-details",
  "connection-address",
  "connection-save",
  "connection-message",
  "connection-retry",
  "connection-reconnect",
] as const;

export class FakeDocument {
  readonly elements = new Map<string, FakeElement>();

  constructor(ids: readonly string[]) {
    for (const id of ids) this.elements.set(id, new FakeElement(id));
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  /** An element that must exist. */
  get(id: string): FakeElement {
    const element = this.elements.get(id);
    if (element === undefined) throw new Error(`no element ${id}`);
    return element;
  }
}

/** A WebSocket the test opens, feeds and closes; it records what was sent. */
export class FakeSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeSocket[] = [];
  readonly url: string;
  readyState = 0;
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  private readonly listeners = new Map<string, ((event: { readonly data?: unknown }) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("send before open");
    const parsed: unknown = JSON.parse(data);
    this.sent.push(parsed);
  }

  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  private fire(type: string, event: { readonly data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    this.fire("open", {});
  }

  /** A raw frame from Stream Deck. */
  deliver(data: unknown): void {
    this.onmessage?.({ data });
    this.fire("message", { data });
  }

  /** A sendToPropertyInspector frame carrying `payload`. */
  deliverPayload(payload: unknown): void {
    this.deliver(JSON.stringify({ event: "sendToPropertyInspector", payload }));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
    this.fire("close", {});
  }

  /** The payloads this page sent to the plugin (sendToPlugin frames). */
  payloads(): unknown[] {
    return this.sent.flatMap((frame) => {
      if (typeof frame !== "object" || frame === null) return [];
      if (Reflect.get(frame, "event") !== "sendToPlugin") return [];
      const payload: unknown = Reflect.get(frame, "payload");
      return [payload];
    });
  }
}
