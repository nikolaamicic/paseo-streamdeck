import { harness } from "./state.ts";

/**
 * Stand-in for createPluginRuntime (M11c check). It records the deps
 * plugin.ts passes and every call of the SDK classes on the event ports.
 * Ports that return a promise in the real runtime return a settled promise
 * here (or one rejected with `harness.rejectNext`, to show a handler awaits
 * it); the others return nothing.
 */

function asyncPort(port: string, method: string) {
  return (...args: unknown[]): Promise<void> => {
    harness.calls.push({ port, method, args });
    // With rejectOnly set, only that port rejects; the others resolve.
    if (harness.rejectOnly !== null && harness.rejectOnly !== `${port}.${method}`) {
      return Promise.resolve();
    }
    const failure = harness.rejectNext;
    harness.rejectNext = null;
    harness.rejectOnly = null;
    return failure === null ? Promise.resolve() : Promise.reject(failure);
  };
}

function voidPort(port: string, method: string) {
  return (...args: unknown[]): void => {
    harness.calls.push({ port, method, args });
  };
}

export function createPluginRuntime(deps: unknown) {
  harness.deps = deps;
  harness.events.push("createPluginRuntime");
  return {
    keys: {
      slotAppeared: voidPort("keys", "slotAppeared"),
      slotDisappeared: voidPort("keys", "slotDisappeared"),
      slotPressed: asyncPort("keys", "slotPressed"),
    },
    pages: {
      appeared: voidPort("pages", "appeared"),
      disappeared: voidPort("pages", "disappeared"),
      rotated: asyncPort("pages", "rotated"),
      pressed: asyncPort("pages", "pressed"),
    },
    workspace: {
      appeared: voidPort("workspace", "appeared"),
      disappeared: voidPort("workspace", "disappeared"),
      settingsReceived: voidPort("workspace", "settingsReceived"),
      rotated: asyncPort("workspace", "rotated"),
      pressed: asyncPort("workspace", "pressed"),
      inspectorShown: asyncPort("workspace", "inspectorShown"),
      inspectorMessage: asyncPort("workspace", "inspectorMessage"),
    },
    usage: {
      appeared: voidPort("usage", "appeared"),
      disappeared: voidPort("usage", "disappeared"),
      rotated: asyncPort("usage", "rotated"),
      pressed: voidPort("usage", "pressed"),
    },
    attention: {
      appeared: voidPort("attention", "appeared"),
      disappeared: voidPort("attention", "disappeared"),
      rotated: voidPort("attention", "rotated"),
      pressed: asyncPort("attention", "pressed"),
    },
    connection: {
      inspectorShown: asyncPort("connection", "inspectorShown"),
      inspectorHidden: voidPort("connection", "inspectorHidden"),
      inspectorMessage: asyncPort("connection", "inspectorMessage"),
    },
    start: (): Promise<void> => {
      harness.events.push("runtime.start");
      return Promise.resolve();
    },
    shutdown: (): Promise<void> => {
      harness.events.push("runtime.shutdown");
      return Promise.resolve();
    },
  };
}
