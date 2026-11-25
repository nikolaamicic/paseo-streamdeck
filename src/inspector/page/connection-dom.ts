import type { PageMessage } from "../connection-protocol.ts";
import { ConnectionPage, type PageView } from "./connection-page.ts";

/**
 * DOM glue of the "Paseo connection" section (C4b). It finds the section's
 * elements by ID, renders the controller's view with textContent only (no
 * HTML from data), wires the three buttons and the address field, and
 * speaks to Stream Deck either through its own socket (connection.html) or
 * through the Workspace page's socket (attach, from workspace.js): one
 * connectElgatoStreamDeckSocket per page.
 *
 * The page has no DOM lib types: `document` is reached through a small
 * checked adapter, so a missing element or API is a visible "not available"
 * instead of a crash. Registration and the message context follow the
 * Workspace inspector, which was checked on Stream Deck 7.6.1: register
 * with the inspector UUID, send with the inspector UUID as context; the
 * plugin's messages carry the action's context.
 */

/** The element operations the section uses. */
export interface SectionElement {
  setText(text: string): void;
  setHidden(hidden: boolean): void;
  setDisabled(disabled: boolean): void;
  getValue(): string;
  setValue(value: string): void;
  on(event: "input" | "click", listener: () => void): void;
}

/** The section's elements; null when the page does not have it. */
export interface SectionElements {
  readonly status: SectionElement;
  readonly details: SectionElement;
  readonly address: SectionElement;
  readonly save: SectionElement;
  readonly message: SectionElement;
  readonly retry: SectionElement;
  readonly reconnect: SectionElement;
}

export const SECTION_IDS = {
  status: "connection-status",
  details: "connection-details",
  address: "connection-address",
  save: "connection-save",
  message: "connection-message",
  retry: "connection-retry",
  reconnect: "connection-reconnect",
} as const;

/** A socket-like channel to Stream Deck, as the Workspace page or our own socket gives. */
export interface Host {
  readonly context: string;
  /** Sends a payload to the plugin; false when not connected. */
  send(payload: PageMessage): boolean;
}

/** What a host forwards to the section. */
export interface Section {
  /** The socket is open and registered. */
  start(): void;
  /** A message from the plugin (the event's payload), unvalidated. */
  receive(payload: unknown): void;
  /** The socket closed or failed. */
  closed(): void;
}

export interface SectionDeps {
  readonly elements: SectionElements;
  readonly host: Host;
  readonly newNonce: () => string;
  readonly after: (delayMs: number, callback: () => void) => { cancel(): void };
}

function viewOf(elements: SectionElements): PageView {
  return {
    setStatus: (text) => {
      elements.status.setText(text);
    },
    setDetails: (lines) => {
      elements.details.setText(lines.join("\n"));
    },
    setMessage: (text) => {
      elements.message.setText(text);
    },
    setRecovery: (kind) => {
      elements.retry.setHidden(kind !== "retry");
      elements.reconnect.setHidden(kind !== "reconnect");
    },
    setInput: (value) => {
      elements.address.setValue(value);
    },
    setSaveEnabled: (enabled) => {
      elements.save.setDisabled(!enabled);
    },
  };
}

/** Builds the section over its elements and a host; wires the controls. */
export function mountSection(deps: SectionDeps): Section {
  const { elements, host } = deps;
  const page = new ConnectionPage({
    context: host.context,
    view: viewOf(elements),
    transport: { send: (message) => host.send(message) },
    newNonce: deps.newNonce,
    after: deps.after,
  });
  elements.address.on("input", () => {
    page.inputChanged(elements.address.getValue());
  });
  elements.save.on("click", () => {
    page.save();
  });
  elements.retry.on("click", () => {
    page.retry();
  });
  elements.reconnect.on("click", () => {
    page.reconnect();
  });
  elements.save.setDisabled(true);
  elements.retry.setHidden(true);
  elements.reconnect.setHidden(true);
  return {
    start: () => {
      page.start();
    },
    receive: (payload) => {
      page.receive(payload);
    },
    closed: () => {
      page.transportClosed();
    },
  };
}

// ---------------------------------------------------------------------------
// A checked adapter over the browser's document, without DOM lib types
// ---------------------------------------------------------------------------

function method(target: object, name: string): ((...args: unknown[]) => unknown) | null {
  const value: unknown = Reflect.get(target, name);
  if (typeof value !== "function") return null;
  return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
}

function asObject(value: unknown): object | null {
  return typeof value === "object" && value !== null ? value : null;
}

/** Wraps one element; null when it is missing or lacks addEventListener. */
export function wrapElement(value: unknown): SectionElement | null {
  const element = asObject(value);
  if (element === null) return null;
  const listen = method(element, "addEventListener");
  if (listen === null) return null;
  return {
    setText: (text) => {
      Reflect.set(element, "textContent", text);
    },
    setHidden: (hidden) => {
      Reflect.set(element, "hidden", hidden);
    },
    setDisabled: (disabled) => {
      Reflect.set(element, "disabled", disabled);
    },
    getValue: () => {
      const value: unknown = Reflect.get(element, "value");
      return typeof value === "string" ? value : "";
    },
    setValue: (text) => {
      Reflect.set(element, "value", text);
    },
    on: (event, listener) => {
      listen(event, listener);
    },
  };
}

/** The section's elements in `doc`, or null if any is missing. */
export function findSection(doc: unknown): SectionElements | null {
  const document = asObject(doc);
  if (document === null) return null;
  const byId = method(document, "getElementById");
  if (byId === null) return null;
  const find = (id: string) => wrapElement(byId(id));
  const status = find(SECTION_IDS.status);
  const details = find(SECTION_IDS.details);
  const address = find(SECTION_IDS.address);
  const save = find(SECTION_IDS.save);
  const message = find(SECTION_IDS.message);
  const retry = find(SECTION_IDS.retry);
  const reconnect = find(SECTION_IDS.reconnect);
  if (
    status === null ||
    details === null ||
    address === null ||
    save === null ||
    message === null ||
    retry === null ||
    reconnect === null
  ) {
    return null;
  }
  return { status, details, address, save, message, retry, reconnect };
}

const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A 22-character page nonce from 16 random bytes (crypto.getRandomValues). */
export function randomNonce(random: (bytes: Uint8Array) => Uint8Array): string {
  const bytes = random(new Uint8Array(16));
  let text = "";
  for (const byte of bytes) text += NONCE_ALPHABET.charAt(byte & 63);
  // 16 symbols of 6 bits, then 6 more from the high bits: 22 symbols in all.
  for (let index = 0; index < 6; index += 1) {
    text += NONCE_ALPHABET.charAt((bytes[index] ?? 0) >> 2);
  }
  return text;
}

// ---------------------------------------------------------------------------
// The standalone page's socket (connection.html)
// ---------------------------------------------------------------------------

/** The socket operations the page uses (the browser's WebSocket). */
export interface PageSocket {
  /** Whether the socket is open now (WebSocket.readyState === OPEN). */
  isOpen(): boolean;
  send(data: string): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (data: unknown) => void): void;
  /** Close and error both end the section. */
  onEnd(listener: () => void): void;
}

/**
 * The page's connectElgatoStreamDeckSocket: registers, then sends and
 * receives through the section. A malformed incoming frame is ignored; a
 * close or error ends the section with a visible message.
 */
export function connectStandalone(
  args: {
    readonly port: unknown;
    readonly uuid: unknown;
    readonly registerEvent: unknown;
    readonly actionInfo: unknown;
  },
  openSocket: (url: string) => PageSocket,
  mount: (host: Host) => Section,
): void {
  const port = String(args.port);
  if (!/^\d+$/.test(port)) return;
  const uuid = String(args.uuid);
  let action = "";
  let context = uuid;
  try {
    const parsed: unknown = JSON.parse(String(args.actionInfo));
    const info = asObject(parsed);
    if (info !== null) {
      const parsedAction: unknown = Reflect.get(info, "action");
      const parsedContext: unknown = Reflect.get(info, "context");
      if (typeof parsedAction === "string") action = parsedAction;
      if (typeof parsedContext === "string") context = parsedContext;
    }
  } catch {
    action = "";
  }
  const socket = openSocket(`ws://127.0.0.1:${port}`);
  const section = mount({
    context,
    send: (payload) => {
      if (!socket.isOpen()) return false;
      socket.send(JSON.stringify({ action, context: uuid, event: "sendToPlugin", payload }));
      return true;
    },
  });
  socket.onOpen(() => {
    socket.send(JSON.stringify({ event: String(args.registerEvent), uuid }));
    section.start();
  });
  socket.onMessage((raw) => {
    const payload = pluginPayload(raw);
    if (payload !== undefined) section.receive(payload);
  });
  socket.onEnd(() => {
    section.closed();
  });
}

/**
 * The payload of a sendToPropertyInspector frame, or undefined for a
 * malformed frame or another event; never throws.
 */
export function pluginPayload(raw: unknown): unknown {
  if (typeof raw !== "string") return undefined;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const frame = asObject(data);
  if (frame === null || Reflect.get(frame, "event") !== "sendToPropertyInspector") return undefined;
  const payload: unknown = Reflect.get(frame, "payload");
  return payload;
}
