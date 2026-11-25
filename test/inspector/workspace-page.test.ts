import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { findSection, mountSection, type Host } from "../../src/inspector/page/connection-dom.ts";
import { connectionStatusView } from "../../src/spike/connection-inspector.ts";
import type { ConnectionFacts } from "../../src/spike/feed-lifecycle.ts";
import { FakeDocument, FakeSocket, PAGE_IDS } from "../../scripts/plugin/inspector-fakes.ts";
import { ManualScheduler } from "../support/fake-client.ts";

/**
 * The Workspace inspector's real workspace.js (C4b integration) in a VM
 * with a fake document and socket, and the real connection section glue
 * attached through PaseoConnection, as workspace.html loads them. It shows
 * one socket, Start in unchanged, and connection_* messages going only to
 * the section. Not a browser and not Stream Deck.
 */

const WORKSPACE_JS = fileURLToPath(
  new URL("../../local.paseocontrol.e1spike.sdPlugin/ui/workspace.js", import.meta.url),
);
const NONCE = "page-nonce-000001";
const CHALLENGE = "challenge-00000001";
const FACTS: ConnectionFacts = {
  view: { kind: "active", daemonUrl: "ws://127.0.0.1:6767/ws", source: "saved" },
  requested: { kind: "connect", daemonUrl: "ws://127.0.0.1:6767/ws", source: "saved" },
  saved: { kind: "ok", daemonUrl: "ws://127.0.0.1:6767/ws" },
  sent: null,
  sending: null,
  link: "connected",
  settingsRead: "idle",
};

function workspacePage() {
  FakeSocket.instances.length = 0;
  const doc = new FakeDocument(PAGE_IDS);
  const clock = new ManualScheduler();
  const elements = findSection(doc);
  assert.ok(elements);
  const sandbox: Record<string, unknown> = {
    document: doc,
    WebSocket: FakeSocket,
    JSON,
    setTimeout: (callback: () => void, delayMs: number) => clock.after(delayMs, callback),
    clearTimeout: (handle: { cancel(): void } | null) => {
      handle?.cancel();
    },
    PaseoConnection: {
      attach: (host: Host) =>
        mountSection({
          elements,
          host,
          newNonce: () => NONCE,
          after: (delayMs, callback) => clock.after(delayMs, callback),
        }),
    },
  };
  sandbox["window"] = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(WORKSPACE_JS, "utf8"), context);
  const connect: unknown = sandbox["connectElgatoStreamDeckSocket"];
  assert.ok(typeof connect === "function");
  Reflect.apply(connect, undefined, [
    28196,
    "inspector-uuid",
    "registerPropertyInspector",
    "{}",
    JSON.stringify({ action: "local.paseocontrol.e1spike.workspace", context: "ctx-w" }),
  ]);
  assert.equal(FakeSocket.instances.length, 1, "one socket for the whole page");
  const socket = FakeSocket.instances[0];
  assert.ok(socket);
  return { doc, socket, clock };
}

/** A Project dial view (P2: canRetry is part of every view). */
const workspaceView = {
  context: "ctx-w",
  status: "Choose the project this dial starts in.",
  notice: null,
  canChoose: true,
  canRetry: false,
  options: [
    { value: "all", label: "All projects", disabled: false },
    { value: "p1", label: "Alpha", disabled: false },
  ],
  selected: "all",
  message: null,
};

describe("the Workspace inspector with the connection section", () => {
  it("one socket: registers, asks for the Start in view and says hello for the connection", () => {
    const h = workspacePage();
    h.socket.open();
    assert.deepEqual(h.socket.sent[0], {
      event: "registerPropertyInspector",
      uuid: "inspector-uuid",
    });
    assert.deepEqual(h.socket.payloads(), [
      { type: "refresh" },
      { type: "connection_hello", pageNonce: NONCE },
    ]);
    for (const frame of h.socket.sent.slice(1)) {
      assert.equal(Reflect.get(Object(frame), "context"), "inspector-uuid");
    }
  });

  it("connection_* messages reach only the section; Start in views reach only Start in", () => {
    const h = workspacePage();
    h.socket.open();
    h.socket.deliverPayload(workspaceView);
    const select = h.doc.get("start-in");
    assert.equal(select.children.length, 2);
    assert.equal(h.doc.get("status").textContent, workspaceView.status);
    h.socket.deliverPayload({
      type: "connection_challenge",
      context: "ctx-w",
      pageNonce: NONCE,
      challenge: CHALLENGE,
    });
    h.socket.deliverPayload({
      type: "connection_bound",
      context: "ctx-w",
      pageNonce: NONCE,
      challenge: CHALLENGE,
      seq: 1,
      status: connectionStatusView(FACTS),
    });
    assert.equal(
      h.doc.get("connection-status").textContent,
      "Connected to Paseo at ws://127.0.0.1:6767/ws.",
    );
    assert.equal(h.doc.get("status").textContent, workspaceView.status, "Start in is untouched");
    assert.equal(select.children.length, 2);
    // A malformed connection message reaches neither part.
    h.socket.deliverPayload({ type: "connection_bogus", context: "ctx-w" });
    assert.equal(h.doc.get("status").textContent, workspaceView.status);
    assert.equal(
      h.doc.get("connection-status").textContent,
      "Connected to Paseo at ws://127.0.0.1:6767/ws.",
    );
  });

  it("choosing a Start in still sends only its own choice; Save sends only connection_save", () => {
    const h = workspacePage();
    h.socket.open();
    h.socket.deliverPayload(workspaceView);
    h.socket.deliverPayload({
      type: "connection_challenge",
      context: "ctx-w",
      pageNonce: NONCE,
      challenge: CHALLENGE,
    });
    h.socket.deliverPayload({
      type: "connection_bound",
      context: "ctx-w",
      pageNonce: NONCE,
      challenge: CHALLENGE,
      seq: 1,
      status: connectionStatusView(FACTS),
    });
    const select = h.doc.get("start-in");
    select.value = "w1";
    select.dispatch("change");
    h.doc.get("connection-save").dispatch("click");
    const types = h.socket
      .payloads()
      .map((payload): unknown => Reflect.get(Object(payload), "type"));
    assert.deepEqual(types, [
      "refresh",
      "connection_hello",
      "connection_confirm",
      "choose",
      "connection_save",
    ]);
    assert.deepEqual(h.socket.payloads()[3], { type: "choose", value: "w1" });
  });

  it("a close ends both parts visibly", () => {
    const h = workspacePage();
    h.socket.open();
    h.socket.close();
    assert.equal(h.doc.get("status").textContent, "Disconnected from Stream Deck.");
    assert.equal(
      h.doc.get("connection-status").textContent,
      "Disconnected from Stream Deck. Close and reopen this inspector.",
    );
  });
});
