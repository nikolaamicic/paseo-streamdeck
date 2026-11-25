import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
  inspectorView,
  sendInspectorView,
  type InspectorFacts,
  type InspectorView,
} from "../../src/spike/workspace-inspector.ts";
import { projectKey } from "../../src/workspaces/project-model.ts";
import { readStartIn, START_IN_ALL, type StartIn } from "../../src/workspaces/start-in-settings.ts";
import { makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

/**
 * Runs the Property Inspector page script (plain browser JavaScript) in a
 * VM with a minimal fake DOM and WebSocket, to check the documented
 * registration, text-only rendering and the messages it sends. Views come
 * from the plugin's own inspectorView and go through sendInspectorView, the
 * function the plugin sends with, so page and plugin cannot drift apart.
 */

const SCRIPT_URL = new URL(
  "../../local.paseocontrol.e1spike.sdPlugin/ui/workspace.js",
  import.meta.url,
);
/** The action instance context; the plugin's views carry it. */
const CONTEXT = "ctx-a";
/** The page's own UUID, which Stream Deck 7.6.1 requires on sendToPlugin. */
const INSPECTOR_UUID = "pi-uuid-1";
const ACTION = "local.paseocontrol.e1spike.workspace";

class FakeElement {
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  children: FakeElement[] = [];
  private readonly listeners = new Map<string, () => void>();

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  dispatch(type: string): void {
    this.listeners.get(type)?.();
  }
}

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(data: string): void {
    this.onmessage?.({ data });
  }
}

/** The page assigns its documented entry point here. */
/** Manual timers, so the answer timeout is tested without waiting. */
class FakeTimers {
  private next = 1;
  readonly pending = new Map<number, { callback: () => void; delay: number }>();

  readonly setTimeout = (callback: () => void, delay: number): number => {
    const id = this.next++;
    this.pending.set(id, { callback, delay });
    return id;
  };

  readonly clearTimeout = (id: number): void => {
    this.pending.delete(id);
  };

  /** Runs the timers due after `ms`. */
  advance(ms: number): void {
    for (const [id, timer] of [...this.pending]) {
      if (timer.delay <= ms) {
        this.pending.delete(id);
        timer.callback();
      }
    }
  }
}

class FakeWindow {
  connectElgatoStreamDeckSocket:
    ((port: string, uuid: string, event: string, info: string, actionInfo: string) => void) | null =
    null;
}

async function loadPage() {
  const elements = new Map([
    ["start-in", new FakeElement()],
    ["status", new FakeElement()],
    ["notice", new FakeElement()],
    ["projects-retry", new FakeElement()],
    ["message", new FakeElement()],
  ]);
  const window = new FakeWindow();
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => new FakeElement(),
  };
  FakeSocket.last = null;
  const timers = new FakeTimers();
  runInNewContext(await readFile(SCRIPT_URL, "utf8"), {
    window,
    document,
    WebSocket: FakeSocket,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const connect = window.connectElgatoStreamDeckSocket;
  assert.ok(connect, "the page defines connectElgatoStreamDeckSocket");
  const element = (id: string): FakeElement => {
    const found = elements.get(id);
    assert.ok(found);
    return found;
  };
  return {
    connect: (port: string) => {
      connect(
        port,
        INSPECTOR_UUID,
        "registerPropertyInspector",
        "{}",
        JSON.stringify({ action: ACTION, context: CONTEXT }),
      );
    },
    select: element("start-in"),
    status: element("status"),
    notice: element("notice"),
    retry: element("projects-retry"),
    message: element("message"),
    timers,
  };
}

const HOSTILE = "<img src=x onerror=alert(1)>";
/** The page of the Project dial (P2): options are projects; values are project keys. */
const W1 = projectKey({ serverId: SERVER_ID, projectId: "p-alpha" });

function facts(overrides: Partial<InspectorFacts> = {}): InspectorFacts {
  return {
    connection: "ok",
    failure: null,
    ready: true,
    stale: false,
    link: "connected",
    serverId: SERVER_ID,
    workspaces: [makeWorkspace({ workspaceId: "w1", projectId: "p-alpha" })],
    truncated: false,
    projects: {
      status: "ready",
      projects: [{ address: { serverId: SERVER_ID, projectId: "p-alpha" }, name: HOSTILE }],
      current: true,
    },
    ...overrides,
  };
}

/**
 * Sends a production view through sendInspectorView to a fake SDK UI and
 * returns the messages Stream Deck would deliver to the page (the SDK wraps
 * the payload in a sendToPropertyInspector event for the visible action).
 */
async function delivered(view: InspectorView, visible: string | null = CONTEXT) {
  const messages: string[] = [];
  const action = visible === null ? undefined : { id: visible };
  await sendInspectorView(
    {
      action,
      sendToPropertyInspector: (payload) => {
        messages.push(
          JSON.stringify({ event: "sendToPropertyInspector", context: visible, payload }),
        );
        return Promise.resolve();
      },
    },
    CONTEXT,
    view,
  );
  return messages;
}

/** The production view for this page, as the plugin would send it. */
async function real(
  overrides: Partial<InspectorFacts> = {},
  message: string | null = null,
  startIn: StartIn = { kind: "project", address: { serverId: SERVER_ID, projectId: "p-alpha" } },
): Promise<string> {
  const [data] = await delivered(inspectorView(CONTEXT, startIn, facts(overrides), message));
  assert.ok(data, "sent to the visible inspector");
  return data;
}

/** A production view with fields replaced, for malformed-input checks. */
function tampered(overrides: Record<string, unknown>): string {
  const view = inspectorView(CONTEXT, START_IN_ALL, facts());
  return JSON.stringify({ event: "sendToPropertyInspector", payload: { ...view, ...overrides } });
}

async function connectedPage() {
  const page = await loadPage();
  page.connect("28196");
  const socket = FakeSocket.last;
  assert.ok(socket);
  socket.open();
  return { ...page, socket };
}

describe("Workspace Property Inspector page", () => {
  it("registers and sends to the plugin with its own UUID, not the action context", async () => {
    const { socket } = await connectedPage();
    assert.equal(socket.url, "ws://127.0.0.1:28196");
    assert.deepEqual(socket.sent, [
      { event: "registerPropertyInspector", uuid: INSPECTOR_UUID },
      {
        action: ACTION,
        context: INSPECTOR_UUID,
        event: "sendToPlugin",
        payload: { type: "refresh" },
      },
    ]);
  });

  it("refuses a port that is not a number", async () => {
    const page = await loadPage();
    page.connect("1/../x");
    assert.equal(FakeSocket.last, null);
  });

  it("renders the plugin's real view as text and selects the saved choice", async () => {
    const { socket, select, status, notice } = await connectedPage();
    socket.receive(await real());
    assert.deepEqual(
      select.children.map((option) => [option.value, option.textContent]),
      [
        ["all", "All projects"],
        [W1, HOSTILE],
      ],
    );
    assert.equal(select.value, W1);
    assert.equal(notice.textContent, "");
    assert.equal(select.disabled, false);
    assert.equal(status.textContent, "Choose the project this dial starts in.");
    assert.doesNotMatch(
      await readFile(SCRIPT_URL, "utf8"),
      /innerHTML|outerHTML|insertAdjacentHTML/,
    );
  });

  it("ignores views for other contexts, malformed messages and settings echoes", async () => {
    const { socket, select, status } = await connectedPage();
    for (const data of [
      tampered({ context: "ctx-b" }),
      tampered({ options: "nope" }),
      tampered({ options: [null] }),
      tampered({ options: [] }),
      tampered({ options: [{ value: "all", label: 7, disabled: false }] }),
      tampered({ options: [{ value: "all", label: "All projects" }] }),
      tampered({ canRetry: undefined }),
      tampered({ selected: "not-listed" }),
      tampered({ status: 1 }),
      tampered({ canChoose: "yes" }),
      tampered({ message: { text: "x" } }),
      tampered({ notice: 0 }),
      tampered({ notice: undefined }),
      "not json",
      "null",
      JSON.stringify({ event: "didReceiveSettings", payload: { settings: {} } }),
    ]) {
      socket.receive(data);
    }
    assert.equal(select.children.length, 0);
    assert.equal(status.textContent, "");
    assert.equal(socket.sent.length, 2, "no extra requests");
  });

  it("keeps the last good view when a malformed one follows", async () => {
    const { socket, select, status } = await connectedPage();
    socket.receive(await real());
    socket.receive(tampered({ status: "Changed", options: [null] }));
    assert.equal(select.children.length, 2);
    assert.equal(status.textContent, "Choose the project this dial starts in.");
  });

  it("shows an earlier version's workspace Start in with its notice, also beyond the list", async () => {
    const { socket, select, notice } = await connectedPage();
    const legacy = readStartIn({
      version: 1,
      startIn: { serverId: SERVER_ID, workspaceId: "far" },
    });
    socket.receive(await real({ truncated: true }, null, legacy.startIn));
    assert.equal(
      notice.textContent,
      "Saved by an earlier version as a workspace. Choose a project to save it as a project.",
    );
    assert.equal(select.value, "saved");
    assert.equal(select.children.at(-1)?.textContent, "Saved workspace (not in the shown list)");
    socket.receive(await real());
    assert.equal(notice.textContent, "");
  });

  it("shows Retry projects only when the plugin offers it, and sends one retry request", async () => {
    const { socket, retry, message, timers } = await connectedPage();
    socket.receive(await real());
    assert.equal(retry.hidden, true, "a current list needs no Retry");
    const unavailable = { status: "unavailable" as const, projects: [], current: false };
    socket.receive(await real({ projects: unavailable }));
    assert.deepEqual([retry.hidden, retry.disabled], [false, false]);
    const before = socket.sent.length;
    retry.dispatch("click");
    assert.deepEqual(socket.sent.at(-1), {
      action: ACTION,
      context: INSPECTOR_UUID,
      event: "sendToPlugin",
      payload: { type: "retry_projects" },
    });
    assert.equal(socket.sent.length, before + 1);
    assert.deepEqual([retry.disabled, message.textContent], [true, "Sending…"]);
    socket.receive(await real({ projects: unavailable }, "Reading the project list again…"));
    assert.equal(message.textContent, "Reading the project list again…");
    assert.equal(timers.pending.size, 0, "the answer cancels the timeout");
    retry.dispatch("click");
    timers.advance(5000);
    assert.equal(message.textContent, "No answer from the plugin. Press Retry projects again.");
    assert.equal(retry.disabled, false, "the user can press again");
  });

  it("receives nothing while another action's inspector or none is visible", async () => {
    const view = inspectorView(CONTEXT, START_IN_ALL, facts());
    assert.deepEqual(await delivered(view, "ctx-b"), []);
    assert.deepEqual(await delivered(view, null), []);
  });

  it("disables the list while the plugin cannot accept a choice", async () => {
    const { socket, select } = await connectedPage();
    socket.receive(await real({ link: "reconnecting" }));
    assert.equal(select.disabled, true);
  });

  it("sends the user's choice and waits for the plugin's answer", async () => {
    const { socket, select, message } = await connectedPage();
    socket.receive(await real());
    select.value = "all";
    select.dispatch("change");
    assert.deepEqual(socket.sent.at(-1), {
      action: ACTION,
      context: INSPECTOR_UUID,
      event: "sendToPlugin",
      payload: { type: "choose", value: "all" },
    });
    assert.equal(select.disabled, true);
    assert.equal(message.textContent, "Sending…");
    socket.receive(await real({}, "Setting sent to Stream Deck.", START_IN_ALL));
    assert.equal(select.disabled, false);
    assert.equal(message.textContent, "Setting sent to Stream Deck.");
  });

  it("leaves Sending… with the last confirmed view when the plugin does not answer", async () => {
    const { socket, select, message, timers } = await connectedPage();
    socket.receive(await real());
    select.value = "all";
    select.dispatch("change");
    timers.advance(4999);
    assert.equal(message.textContent, "Sending…", "still waiting before the timeout");
    timers.advance(5000);
    assert.equal(
      message.textContent,
      "No answer from the plugin; the setting is not confirmed. Choose again to retry.",
    );
    assert.equal(select.disabled, false, "the user can retry");
    assert.equal(select.value, W1, "the unconfirmed choice is not shown as selected");
    select.value = "all";
    select.dispatch("change");
    assert.equal(socket.sent.filter((data) => JSON.stringify(data).includes('"choose"')).length, 2);
  });

  it("cancels the timeout when the answer arrives", async () => {
    const { socket, select, message, timers } = await connectedPage();
    socket.receive(await real());
    select.value = "all";
    select.dispatch("change");
    socket.receive(await real({}, "Setting sent to Stream Deck.", START_IN_ALL));
    assert.equal(timers.pending.size, 0);
    assert.equal(message.textContent, "Setting sent to Stream Deck.");
  });

  it("says nothing was sent when the socket is not open", async () => {
    const { socket, select, message } = await connectedPage();
    socket.receive(await real());
    socket.readyState = 3;
    select.value = "all";
    select.dispatch("change");
    assert.equal(message.textContent, "Not connected to Stream Deck; nothing was sent.");
    assert.equal(select.value, W1);
  });

  it("shows a lost connection and stops accepting choices", async () => {
    const { socket, select, status } = await connectedPage();
    socket.receive(await real());
    socket.onclose?.();
    assert.equal(select.disabled, true);
    assert.equal(status.textContent, "Disconnected from Stream Deck.");
  });
});
