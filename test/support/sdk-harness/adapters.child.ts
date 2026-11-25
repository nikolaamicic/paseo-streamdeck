import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import fakeStreamDeck from "./fake-streamdeck.ts";
import { harness, type PortCall } from "./state.ts";
import { isSessionId } from "../../../src/inspector/connection-protocol.ts";

/**
 * The SDK adapter check (M11c), run only in the child process that
 * test/spike/sdk-adapters.test.ts starts with hooks.ts. It imports the real
 * src/spike/plugin.ts, whose SDK, Paseo client package and runtime are the
 * fakes next to this file, and drives the plugin's real SDK action classes
 * with fake events. It proves the classes' guards, handles and port calls
 * and the start sequence under the fake SDK; it does not prove the real
 * SDK's event dispatch, transport or a device.
 */

const PLUGIN_ENTRY = new URL("../../../src/spike/plugin.ts", import.meta.url).href;

/**
 * The UUIDs plugin.ts registered before M11a, in that order (literal on
 * purpose), without the E1 action removed at the user's request (2026-11-25).
 */
const HISTORICAL_REGISTRATION = [
  "local.paseocontrol.e1spike.workspace",
  "local.paseocontrol.e1spike.slot",
  "local.paseocontrol.e1spike.pages",
  "local.paseocontrol.e1spike.usage",
  "local.paseocontrol.e1spike.attention",
];

const signals = new Map<string, () => void>();

before(async () => {
  // plugin.ts hooks SIGTERM and SIGINT with process.once; record them
  // instead of adding real handlers, and restore while still loading.
  const originalOnce: unknown = Reflect.get(process, "once");
  Reflect.set(process, "once", (signal: string, handler: () => void) => {
    harness.events.push(`signal:${signal}`);
    signals.set(signal, handler);
    return process;
  });
  try {
    await import(PLUGIN_ENTRY);
  } finally {
    Reflect.set(process, "once", originalOnce);
  }
});

/** A recorded call on a fake SDK action, with the object it was called on. */
interface ActionCall {
  readonly self: unknown;
  readonly method: string;
  readonly args: readonly unknown[];
}

/** A fake SDK action instance: kind checks and recorded handle methods. */
function fakeAction(kind: "key" | "dial", inMultiAction = false) {
  const calls: ActionCall[] = [];
  const action = {
    calls,
    id: "ctx-1",
    device: { id: "dev-1" },
    coordinates: { column: 2, row: 1 },
    isKey: () => kind === "key",
    isDial: () => kind === "dial",
    isInMultiAction: () => inMultiAction,
    setImage(this: unknown, ...args: unknown[]): Promise<void> {
      calls.push({ self: this, method: "setImage", args });
      return Promise.resolve();
    },
    setTitle(this: unknown, ...args: unknown[]): Promise<void> {
      calls.push({ self: this, method: "setTitle", args });
      return Promise.resolve();
    },
    setFeedback(this: unknown, ...args: unknown[]): Promise<void> {
      calls.push({ self: this, method: "setFeedback", args });
      return Promise.resolve();
    },
    setSettings(this: unknown, ...args: unknown[]): Promise<void> {
      calls.push({ self: this, method: "setSettings", args });
      return Promise.resolve();
    },
    showAlert(this: unknown, ...args: unknown[]): Promise<void> {
      calls.push({ self: this, method: "showAlert", args });
      return Promise.resolve();
    },
    showOk(this: unknown, ...args: unknown[]): Promise<void> {
      calls.push({ self: this, method: "showOk", args });
      return Promise.resolve();
    },
  };
  return action;
}

/** The registered action instance for a manifest UUID. */
function registered(uuid: string): object {
  const action = harness.registered.find(
    (candidate) => Reflect.get(candidate, "manifestId") === uuid,
  );
  assert.ok(action, `${uuid} is registered`);
  return action;
}

/** Calls an SDK event handler of a registered action, on that action. */
function fire(action: object, handlerName: string, event: unknown): unknown {
  const handler: unknown = Reflect.get(action, handlerName);
  assert.ok(typeof handler === "function", `${handlerName} exists`);
  const result: unknown = Reflect.apply(handler, action, [event]);
  return result;
}

/** The port calls made while `run` executes. */
function portCalls(run: () => void): PortCall[] {
  const mark = harness.calls.length;
  run();
  return harness.calls.slice(mark);
}

/** port.method with each argument, the fake action shown as "action". */
function described(calls: readonly PortCall[], action: object): unknown[][] {
  return calls.map((call) => [
    `${call.port}.${call.method}`,
    ...call.args.map((arg) => (arg === action ? "action" : arg)),
  ]);
}

/** The handle object the last port call received as its first argument. */
function lastHandle(calls: readonly PortCall[]): object {
  const handle: unknown = calls.at(-1)?.args[0];
  assert.ok(typeof handle === "object" && handle !== null, "a handle object");
  return handle;
}

/** Calls a handle method by name, as the controller would. */
async function callHandle(handle: object, method: string, ...args: unknown[]): Promise<void> {
  const fn: unknown = Reflect.get(handle, method);
  assert.ok(typeof fn === "function", `handle.${method} exists`);
  const result: unknown = Reflect.apply(fn, handle, args);
  await result;
}

/**
 * Shows that an async SDK handler awaits (or returns) its port's promise:
 * the port rejects with a marker, and the handler's promise must reject
 * with it. A handler that dropped the promise would settle normally.
 */
async function assertAwaitsPort(run: () => unknown, only: string | null = null): Promise<void> {
  const marker = new Error("port outcome");
  harness.rejectNext = marker;
  harness.rejectOnly = only;
  await assert.rejects(
    async () => {
      await run();
    },
    (error: unknown) => error === marker,
  );
  assert.equal(harness.rejectNext, null, "the port was called");
}

describe("the real plugin.ts under a fake SDK and runtime", () => {
  it("loads neither the real SDK nor the Paseo client package, and creates no client", () => {
    assert.deepEqual([...harness.loadedPackages], []);
    assert.equal(harness.events.includes("createPaseoClient"), false);
  });

  it("starts in its historical order: logger, runtime, signals, actions, connect, start", () => {
    assert.deepEqual(harness.events, [
      "logger.setLevel:info",
      `log.info:plugin start: node ${process.version}, ${process.platform}-${process.arch}`,
      "createPluginRuntime",
      "signal:SIGTERM",
      "signal:SIGINT",
      ...HISTORICAL_REGISTRATION.map((uuid) => `register:${uuid}`),
      "connect",
      "runtime.start",
    ]);
    assert.equal(
      new Set(harness.registered.map((action) => action.constructor)).size,
      5,
      "five distinct action classes",
    );
  });

  it("passes the SDK logger itself and gates inspector views on the open inspector", async () => {
    const deps = harness.deps;
    assert.ok(typeof deps === "object" && deps !== null);
    assert.equal(Reflect.get(deps, "log"), fakeStreamDeck.logger);
    harness.uiAction = { id: "ctx-open" };
    await callHandle(deps, "sendToInspector", "ctx-closed", { context: "ctx-closed" });
    await callHandle(deps, "sendToInspector", "ctx-open", { context: "ctx-open" });
    assert.deepEqual(harness.inspector, [{ context: "ctx-open" }]);
    harness.uiAction = null;
  });

  it("forwards the public settings methods: the answer, each event's settings, and disposal", async () => {
    const deps = harness.deps;
    assert.ok(typeof deps === "object" && deps !== null);
    assert.equal(
      harness.events.some((event) => event.startsWith("settings.")),
      false,
      "loading plugin.ts reads no settings; the runtime does, after connect",
    );

    const saved = { connection: { version: 1, daemonUrl: "ws://127.0.0.1:7000/ws" } };
    harness.settings.answer = saved;
    const get: unknown = Reflect.get(deps, "getGlobalSettings");
    assert.ok(typeof get === "function");
    const answered: unknown = await Reflect.apply(get, deps, []);
    assert.equal(answered, saved, "the SDK's answer object itself");

    const received: unknown[] = [];
    const subscribe: unknown = Reflect.get(deps, "subscribeGlobalSettings");
    assert.ok(typeof subscribe === "function");
    const subscription: unknown = Reflect.apply(subscribe, deps, [
      (settings: unknown) => received.push(settings),
    ]);
    assert.equal(harness.settings.listeners.length, 1);
    const changed = { other: true };
    for (const listener of harness.settings.listeners) listener({ settings: changed });
    assert.equal(received[0], changed, "each event's settings object, unwrapped");

    assert.ok(typeof subscription === "object" && subscription !== null);
    await callHandle(subscription, "dispose");
    assert.equal(harness.settings.listeners.length, 0, "disposed through Symbol.dispose");
    assert.deepEqual(
      harness.events.filter((event) => event.startsWith("settings.")),
      ["settings.getGlobalSettings", "settings.onDidReceiveGlobalSettings", "settings.dispose"],
    );
  });

  it("forwards setGlobalSettings: the same whole object, the SDK's settings as this, its promise and rejection", async () => {
    const deps = harness.deps;
    assert.ok(typeof deps === "object" && deps !== null);
    assert.equal(
      harness.events.includes("settings.setGlobalSettings"),
      false,
      "loading or starting plugin.ts writes no settings; only a Save does",
    );
    const set: unknown = Reflect.get(deps, "setGlobalSettings");
    assert.ok(typeof set === "function");

    const whole = {
      other: { keep: [1, "x"] },
      connection: { version: 1, daemonUrl: "ws://127.0.0.1:7000/ws" },
    };
    const sent: unknown = await Reflect.apply(set, deps, [whole]);
    assert.equal(sent, undefined, "resolves as the SDK does");
    assert.equal(harness.settings.writes.length, 1);
    assert.equal(harness.settings.writes[0]?.settings, whole, "the same object, not a copy");
    assert.equal(
      harness.settings.writes[0].self,
      fakeStreamDeck.settings,
      "called on streamDeck.settings",
    );

    const refused = new Error("refused by the fake SDK");
    harness.settings.refuseNextWrite = refused;
    await assert.rejects(
      async () => {
        await Reflect.apply(set, deps, [whole]);
      },
      (error: unknown) => error === refused,
      "the SDK's rejection reaches the caller unchanged",
    );
    assert.equal(harness.settings.writes.length, 2);
  });

  it("passes a challenge generator: valid, distinct identities", () => {
    const deps = harness.deps;
    assert.ok(typeof deps === "object" && deps !== null);
    const make: unknown = Reflect.get(deps, "newChallenge");
    assert.ok(typeof make === "function");
    const first: unknown = Reflect.apply(make, deps, []);
    const second: unknown = Reflect.apply(make, deps, []);
    assert.ok(typeof first === "string" && isSessionId(first), "a protocol session ID");
    assert.notEqual(first, second);
  });

  it("a terminating signal runs the runtime's shutdown", () => {
    const onTerm = signals.get("SIGTERM");
    assert.ok(onTerm);
    onTerm();
    assert.equal(harness.events.at(-1), "runtime.shutdown");
  });

  it("workspace key: dials and multi-action keys are ignored; the handle forwards to the action", async () => {
    const slot = registered("local.paseocontrol.e1spike.slot");
    assert.deepEqual(
      portCalls(() => {
        fire(slot, "onWillAppear", { action: fakeAction("dial") });
        fire(slot, "onWillAppear", { action: fakeAction("key", true) });
      }),
      [],
    );
    const action = fakeAction("key");
    const appeared = portCalls(() => {
      assert.equal(fire(slot, "onWillAppear", { action }), undefined);
    });
    assert.deepEqual(
      appeared.map((call) => `${call.port}.${call.method}`),
      ["keys.slotAppeared"],
    );
    const handle = lastHandle(appeared);
    assert.equal(Reflect.get(handle, "id"), "ctx-1");
    assert.equal(Reflect.get(handle, "deviceId"), "dev-1");
    assert.equal(Reflect.get(handle, "coordinates"), action.coordinates, "the same object");
    await callHandle(handle, "setImage", "image-1");
    await callHandle(handle, "setTitle", "");
    await callHandle(handle, "showAlert");
    await callHandle(handle, "showOk");
    assert.deepEqual(
      action.calls.map((call) => [call.method, call.self === action, ...call.args]),
      [
        ["setImage", true, "image-1"],
        ["setTitle", true, ""],
        ["showAlert", true],
        ["showOk", true],
      ],
    );
    assert.deepEqual(
      described(
        portCalls(() => fire(slot, "onWillDisappear", { action })),
        action,
      ),
      [["keys.slotDisappeared", "ctx-1"]],
    );
    await assertAwaitsPort(() => fire(slot, "onKeyDown", { action }));
    assert.deepEqual(described(harness.calls.slice(-1), action), [["keys.slotPressed", "action"]]);
  });

  it("Pages dial: keys are ignored; id, device and feedback; the action and ticks on turn and press", async () => {
    const pages = registered("local.paseocontrol.e1spike.pages");
    assert.deepEqual(
      portCalls(() => fire(pages, "onWillAppear", { action: fakeAction("key") })),
      [],
    );
    const action = fakeAction("dial");
    const appeared = portCalls(() => fire(pages, "onWillAppear", { action }));
    assert.equal(appeared[0]?.method, "appeared");
    const handle = lastHandle(appeared);
    assert.deepEqual(
      [Reflect.get(handle, "id"), Reflect.get(handle, "deviceId")],
      ["ctx-1", "dev-1"],
    );
    const strip = { label: "Agent pages" };
    await callHandle(handle, "setFeedback", strip);
    assert.deepEqual(
      action.calls.map((call) => [call.method, call.self === action, ...call.args]),
      [["setFeedback", true, strip]],
    );
    assert.equal(action.calls[0]?.args[0], strip, "the same payload object");
    assert.deepEqual(
      described(
        portCalls(() => fire(pages, "onWillDisappear", { action })),
        action,
      ),
      [["pages.disappeared", "ctx-1"]],
    );
    await assertAwaitsPort(() => fire(pages, "onDialRotate", { action, payload: { ticks: -3 } }));
    assert.deepEqual(described(harness.calls.slice(-1), action), [["pages.rotated", "action", -3]]);
    await assertAwaitsPort(() => fire(pages, "onDialDown", { action }));
    assert.deepEqual(described(harness.calls.slice(-1), action), [["pages.pressed", "action"]]);
  });

  it("Usage dial: keys are ignored; id and feedback only; the turn is awaited, the press is by ID", async () => {
    const usage = registered("local.paseocontrol.e1spike.usage");
    assert.deepEqual(
      portCalls(() => fire(usage, "onWillAppear", { action: fakeAction("key") })),
      [],
    );
    const action = fakeAction("dial");
    const appeared = portCalls(() => fire(usage, "onWillAppear", { action }));
    const handle = lastHandle(appeared);
    assert.deepEqual(Object.keys(handle).sort(), ["id", "setFeedback"]);
    assert.equal(Reflect.get(handle, "id"), "ctx-1");
    const strip = { counter: "1/1" };
    await callHandle(handle, "setFeedback", strip);
    assert.equal(action.calls[0]?.self, action);
    assert.equal(action.calls[0].args[0], strip);
    const calls = portCalls(() => {
      assert.equal(fire(usage, "onWillDisappear", { action }), undefined);
      assert.equal(fire(usage, "onDialDown", { action }), undefined);
    });
    assert.deepEqual(described(calls, action), [
      ["usage.disappeared", "ctx-1"],
      ["usage.pressed", "ctx-1"],
    ]);
    await assertAwaitsPort(() => fire(usage, "onDialRotate", { action, payload: { ticks: 2 } }));
    assert.deepEqual(described(harness.calls.slice(-1), action), [["usage.rotated", "action", 2]]);
  });

  it("Attention dial: keys are ignored; id and feedback only; turn by ID and ticks; the press is awaited", async () => {
    const attention = registered("local.paseocontrol.e1spike.attention");
    assert.deepEqual(
      portCalls(() => fire(attention, "onWillAppear", { action: fakeAction("key") })),
      [],
    );
    const action = fakeAction("dial");
    const handle = lastHandle(portCalls(() => fire(attention, "onWillAppear", { action })));
    assert.deepEqual(Object.keys(handle).sort(), ["id", "setFeedback"]);
    assert.equal(Reflect.get(handle, "id"), "ctx-1");
    const strip = { counter: "1/2" };
    await callHandle(handle, "setFeedback", strip);
    assert.equal(action.calls[0]?.self, action);
    assert.equal(action.calls[0].args[0], strip);
    const calls = portCalls(() => {
      assert.equal(fire(attention, "onWillDisappear", { action }), undefined);
      assert.equal(fire(attention, "onDialRotate", { action, payload: { ticks: 1 } }), undefined);
    });
    assert.deepEqual(described(calls, action), [
      ["attention.disappeared", "ctx-1"],
      ["attention.rotated", "ctx-1", 1],
    ]);
    await assertAwaitsPort(() => fire(attention, "onDialDown", { action }));
    assert.deepEqual(described(harness.calls.slice(-1), action), [["attention.pressed", "action"]]);
  });

  it("Workspace dial: keys are ignored; handle, raw settings and payload identity; four awaited handlers", async () => {
    const workspace = registered("local.paseocontrol.e1spike.workspace");
    assert.deepEqual(
      portCalls(() =>
        fire(workspace, "onWillAppear", { action: fakeAction("key"), payload: { settings: {} } }),
      ),
      [],
    );
    const action = fakeAction("dial");
    const settings = { version: 1, startIn: null };
    const appeared = portCalls(() =>
      fire(workspace, "onWillAppear", { action, payload: { settings } }),
    );
    assert.equal(appeared[0]?.method, "appeared");
    const handle = lastHandle(appeared);
    assert.equal(appeared[0].args[1], settings, "the raw settings object");
    assert.deepEqual(
      [Reflect.get(handle, "id"), Reflect.get(handle, "deviceId")],
      ["ctx-1", "dev-1"],
    );
    const stored = { version: 1, startIn: null };
    const strip = { label: "Workspace" };
    await callHandle(handle, "setSettings", stored);
    await callHandle(handle, "setFeedback", strip);
    assert.deepEqual(
      action.calls.map((call) => [call.method, call.self === action, call.args[0]]),
      [
        ["setSettings", true, stored],
        ["setFeedback", true, strip],
      ],
    );
    const changed = { version: 1, startIn: { serverId: "srv", workspaceId: "w" } };
    const calls = portCalls(() => {
      assert.equal(fire(workspace, "onWillDisappear", { action }), undefined);
      assert.equal(
        fire(workspace, "onDidReceiveSettings", { action, payload: { settings: changed } }),
        undefined,
      );
    });
    assert.deepEqual(described(calls, action), [
      ["workspace.disappeared", "ctx-1"],
      ["workspace.settingsReceived", "ctx-1", changed],
    ]);
    assert.equal(calls[1]?.args[1], changed, "the raw settings object");

    const message = { type: "choose", value: "x" };
    await assertAwaitsPort(() =>
      fire(workspace, "onDialRotate", { action, payload: { ticks: 4 } }),
    );
    await assertAwaitsPort(() => fire(workspace, "onDialDown", { action }));
    // Appearance: the connection session and the Start in view, both awaited.
    await assertAwaitsPort(
      () => fire(workspace, "onPropertyInspectorDidAppear", { action }),
      "workspace.inspectorShown",
    );
    await assertAwaitsPort(() => fire(workspace, "onSendToPlugin", { action, payload: message }));
    const last = harness.calls.slice(-5);
    assert.deepEqual(described(last, action), [
      ["workspace.rotated", "action", 4],
      ["workspace.pressed", "action"],
      ["connection.inspectorShown", "ctx-1"],
      ["workspace.inspectorShown", "ctx-1"],
      ["workspace.inspectorMessage", "ctx-1", message],
    ]);
    assert.equal(last[4]?.args[1], message, "the raw inspector payload");
  });

  it("every action's inspector: appear, disappear and messages reach the connection port; Workspace routes connection messages first", async () => {
    const uuids: [string, "key" | "dial"][] = [
      ["local.paseocontrol.e1spike.workspace", "dial"],
      ["local.paseocontrol.e1spike.slot", "key"],
      ["local.paseocontrol.e1spike.pages", "dial"],
      ["local.paseocontrol.e1spike.usage", "dial"],
      ["local.paseocontrol.e1spike.attention", "dial"],
    ];
    for (const [uuid, kind] of uuids) {
      const instance = registered(uuid);
      const action = fakeAction(kind);
      const save = { type: "connection_save", requestId: "r1", daemonUrl: "ws://localhost:1/ws" };
      await assertAwaitsPort(
        () => fire(instance, "onPropertyInspectorDidAppear", { action }),
        "connection.inspectorShown",
      );
      const hidden = portCalls(() => {
        assert.equal(fire(instance, "onPropertyInspectorDidDisappear", { action }), undefined);
      });
      await assertAwaitsPort(() => fire(instance, "onSendToPlugin", { action, payload: save }));
      const last = harness.calls.slice(-1);
      assert.deepEqual(described(hidden, action), [["connection.inspectorHidden", "ctx-1"]], uuid);
      assert.deepEqual(described(last, action), [["connection.inspectorMessage", "ctx-1", save]]);
      assert.equal(last[0]?.args[1], save, `${uuid}: the raw payload itself`);
    }

    // Workspace: a connection message, also a malformed one, never reaches Start in.
    const workspace = registered("local.paseocontrol.e1spike.workspace");
    const action = fakeAction("dial");
    const malformed = { type: "connection_unknown" };
    const startIn = { type: "choose", value: "x" };
    const mark = harness.calls.length;
    await fire(workspace, "onSendToPlugin", { action, payload: malformed });
    await fire(workspace, "onSendToPlugin", { action, payload: startIn });
    assert.deepEqual(described(harness.calls.slice(mark), action), [
      ["connection.inspectorMessage", "ctx-1", malformed],
      ["workspace.inspectorMessage", "ctx-1", startIn],
    ]);
  });
});
