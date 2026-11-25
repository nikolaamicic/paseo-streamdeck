import {
  connectStandalone,
  findSection,
  mountSection,
  randomNonce,
  type Host,
  type PageSocket,
  type Section,
} from "./connection-dom.ts";

/**
 * Browser entry of ui/connection.js (C4b), bundled by rollup as a script
 * for Stream Deck's Property Inspector view. It exposes
 * `PaseoConnection.attach(host)` for a page that owns the socket (the
 * Workspace inspector, workspace.js) and, only when the page has no
 * connectElgatoStreamDeckSocket yet, defines it with its own socket
 * (connection.html): one socket per page. workspace.html loads workspace.js
 * first, so its socket stays the only one there.
 */

const NO_SECTION: Section = {
  start: () => undefined,
  receive: () => undefined,
  closed: () => undefined,
};

const elements = findSection(Reflect.get(globalThis, "document"));

function mount(host: Host): Section {
  if (elements === null) return NO_SECTION;
  return mountSection({
    elements,
    host,
    newNonce: () => randomNonce((bytes) => crypto.getRandomValues(bytes)),
    after: (delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      return {
        cancel: () => {
          clearTimeout(timer);
        },
      };
    },
  });
}

function openSocket(url: string): PageSocket {
  const socket = new WebSocket(url);
  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (data) => {
      socket.send(data);
    },
    onOpen: (listener) => {
      socket.addEventListener("open", () => {
        listener();
      });
    },
    onMessage: (listener) => {
      socket.addEventListener("message", (event) => {
        const data: unknown = event.data;
        listener(data);
      });
    },
    onEnd: (listener) => {
      socket.addEventListener("close", () => {
        listener();
      });
      socket.addEventListener("error", () => {
        listener();
      });
    },
  };
}

Reflect.set(globalThis, "PaseoConnection", { attach: mount });

if (typeof Reflect.get(globalThis, "connectElgatoStreamDeckSocket") !== "function") {
  Reflect.set(
    globalThis,
    "connectElgatoStreamDeckSocket",
    (port: unknown, uuid: unknown, registerEvent: unknown, _info: unknown, actionInfo: unknown) => {
      connectStandalone({ port, uuid, registerEvent, actionInfo }, openSocket, mount);
    },
  );
}
