import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSessionId } from "../../src/inspector/connection-protocol.ts";
import {
  connectStandalone,
  findSection,
  mountSection,
  pluginPayload,
  randomNonce,
  type PageSocket,
} from "../../src/inspector/page/connection-dom.ts";
import { connectionStatusView } from "../../src/spike/connection-inspector.ts";
import type { ConnectionFacts } from "../../src/spike/feed-lifecycle.ts";
import { FakeDocument, FakeSocket, PAGE_IDS } from "../../scripts/plugin/inspector-fakes.ts";
import { ManualScheduler } from "../support/fake-client.ts";

/**
 * The DOM glue of the connection section (C4b) over a fake document and a
 * fake socket: element wiring, text-only rendering, the standalone socket
 * (registration, context, malformed frames, close) and nonces. Synthetic
 * plugin messages; no browser, Stream Deck or plugin.
 */

const FACTS: ConnectionFacts = {
  view: { kind: "active", daemonUrl: "ws://127.0.0.1:6767/ws", source: "saved" },
  requested: { kind: "connect", daemonUrl: "ws://127.0.0.1:6767/ws", source: "saved" },
  saved: { kind: "ok", daemonUrl: "ws://127.0.0.1:6767/ws" },
  sent: null,
  sending: null,
  link: "connected",
  settingsRead: "idle",
};
const NONCE = "page-nonce-000001";
const CHALLENGE = "challenge-00000001";

/** The fake socket as the glue's PageSocket. */
function asPageSocket(socket: FakeSocket): PageSocket {
  return {
    isOpen: () => socket.readyState === FakeSocket.OPEN,
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
        listener(event.data);
      });
    },
    onEnd: (listener) => {
      socket.addEventListener("close", () => {
        listener();
      });
    },
  };
}

function standalone() {
  const doc = new FakeDocument(PAGE_IDS);
  const elements = findSection(doc);
  assert.ok(elements, "the section is found");
  const clock = new ManualScheduler();
  let socket: FakeSocket | null = null;
  connectStandalone(
    {
      port: 28196,
      uuid: "inspector-uuid",
      registerEvent: "registerPropertyInspector",
      actionInfo: JSON.stringify({ action: "local.paseocontrol.e1spike.pages", context: "ctx-1" }),
    },
    (url) => {
      socket = new FakeSocket(url);
      return asPageSocket(socket);
    },
    (host) =>
      mountSection({
        elements,
        host,
        newNonce: () => NONCE,
        after: (delayMs, callback) => clock.after(delayMs, callback),
      }),
  );
  assert.ok(socket);
  const opened: FakeSocket = socket;
  const bindPage = () => {
    opened.deliverPayload({
      type: "connection_challenge",
      context: "ctx-1",
      pageNonce: NONCE,
      challenge: CHALLENGE,
    });
    opened.deliverPayload({
      type: "connection_bound",
      context: "ctx-1",
      pageNonce: NONCE,
      challenge: CHALLENGE,
      seq: 1,
      status: connectionStatusView(FACTS),
    });
  };
  return { doc, socket: opened, clock, bindPage };
}

describe("connection section DOM glue", () => {
  it("registers with the inspector UUID and sends with it as context; the hello only after open", () => {
    const h = standalone();
    assert.equal(h.socket.url, "ws://127.0.0.1:28196");
    assert.equal(h.socket.sent.length, 0, "nothing before open");
    h.socket.open();
    assert.deepEqual(h.socket.sent, [
      { event: "registerPropertyInspector", uuid: "inspector-uuid" },
      {
        action: "local.paseocontrol.e1spike.pages",
        context: "inspector-uuid",
        event: "sendToPlugin",
        payload: { type: "connection_hello", pageNonce: NONCE },
      },
    ]);
    assert.equal(h.doc.get("connection-status").textContent, "Waiting for the plugin…");
    assert.deepEqual(
      [h.doc.get("connection-save").disabled, h.doc.get("connection-retry").hidden],
      [true, false],
    );
  });

  it("binds through the plugin's messages; Save clicks send exactly one Save with the field's text", () => {
    const h = standalone();
    h.socket.open();
    h.bindPage();
    assert.equal(
      h.doc.get("connection-status").textContent,
      "Connected to Paseo at ws://127.0.0.1:6767/ws.",
    );
    assert.equal(h.doc.get("connection-address").value, "ws://127.0.0.1:6767/ws");
    assert.equal(h.doc.get("connection-save").disabled, false);
    const address = h.doc.get("connection-address");
    address.value = "ws://localhost:7002/ws";
    address.dispatch("input");
    h.doc.get("connection-save").dispatch("click");
    h.doc.get("connection-save").dispatch("click");
    const saves = h.socket
      .payloads()
      .filter((payload) => Reflect.get(Object(payload), "type") === "connection_save");
    assert.equal(saves.length, 1);
    assert.equal(Reflect.get(Object(saves[0]), "daemonUrl"), "ws://localhost:7002/ws");
    assert.equal(h.doc.get("connection-save").disabled, true);
    h.clock.advance(5_000);
    assert.match(h.doc.get("connection-message").textContent, /unknown/);
  });

  it("text from messages is set as text, never as HTML", () => {
    const h = standalone();
    h.socket.open();
    h.bindPage();
    h.socket.deliverPayload({
      type: "connection_status",
      context: "ctx-1",
      pageNonce: NONCE,
      challenge: CHALLENGE,
      seq: 2,
      requestId: null,
      status: connectionStatusView({
        ...FACTS,
        view: { kind: "active", daemonUrl: "<b>x</b>", source: "saved" },
      }),
    });
    assert.equal(h.doc.get("connection-status").textContent, "Connected to Paseo at <b>x</b>.");
  });

  it("malformed frames, other events and foreign packets are ignored without breaking the page", () => {
    const h = standalone();
    h.socket.open();
    for (const raw of [
      "{not json",
      "null",
      "[]",
      JSON.stringify({ event: "didReceiveSettings" }),
      42,
    ]) {
      h.socket.deliver(raw);
    }
    h.socket.deliverPayload({
      type: "connection_challenge",
      context: "other",
      pageNonce: NONCE,
      challenge: CHALLENGE,
    });
    assert.equal(h.doc.get("connection-status").textContent, "Waiting for the plugin…");
    h.bindPage();
    assert.equal(h.doc.get("connection-save").disabled, false, "still works afterwards");
    assert.equal(pluginPayload("{"), undefined);
  });

  it("Retry resends the same hello; Reconnect appears only after a reset; a close disables everything", () => {
    const h = standalone();
    h.socket.open();
    h.doc.get("connection-retry").dispatch("click");
    const hellos = h.socket
      .payloads()
      .filter((payload) => Reflect.get(Object(payload), "type") === "connection_hello");
    assert.deepEqual(hellos, [
      { type: "connection_hello", pageNonce: NONCE },
      { type: "connection_hello", pageNonce: NONCE },
    ]);
    h.bindPage();
    h.socket.deliverPayload({ type: "connection_ready", context: "ctx-1" });
    assert.equal(h.doc.get("connection-reconnect").hidden, false);
    assert.equal(h.doc.get("connection-save").disabled, true);
    h.socket.close();
    assert.equal(
      h.doc.get("connection-status").textContent,
      "Disconnected from Stream Deck. Close and reopen this inspector.",
    );
    assert.deepEqual(
      [h.doc.get("connection-save").disabled, h.doc.get("connection-reconnect").hidden],
      [true, true],
    );
    const sent = h.socket.sent.length;
    h.doc.get("connection-save").dispatch("click");
    assert.equal(h.socket.sent.length, sent);
  });

  it("a page without the section, or an element without listeners, mounts nothing", () => {
    assert.equal(findSection(new FakeDocument(["start-in"])), null);
    assert.equal(findSection(null), null);
    assert.equal(findSection({}), null);
  });

  it("nonces are 22 protocol-safe characters and differ", () => {
    let seed = 0;
    const random = (bytes: Uint8Array) => {
      for (let index = 0; index < bytes.length; index += 1)
        bytes[index] = (seed + index * 37) % 256;
      seed += 1;
      return bytes;
    };
    const first = randomNonce(random);
    const second = randomNonce(random);
    assert.equal(first.length, 22);
    assert.ok(isSessionId(first) && isSessionId(second));
    assert.notEqual(first, second);
  });
});
