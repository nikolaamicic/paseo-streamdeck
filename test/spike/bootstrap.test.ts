import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { ACTION_IDS, REGISTRATION_ORDER, type ActionName } from "../../src/spike/action-ids.ts";
import {
  bootstrapPlugin,
  type BootstrapDeps,
  type ShutdownSignal,
} from "../../src/spike/bootstrap.ts";
import { deferred } from "../support/fake-client.ts";

/**
 * The plugin's start sequence (M11a) with fakes: no Stream Deck connection,
 * no process signals, no daemon. The action list is the one plugin.ts
 * registers (REGISTRATION_ORDER) and is checked against manifest.json.
 */

function harness(overrides: Partial<BootstrapDeps<string>> = {}) {
  const calls: string[] = [];
  const handlers = new Map<ShutdownSignal, () => void>();
  let shutdowns = 0;
  const deps: BootstrapDeps<string> = {
    onceSignal: (signal, handler) => {
      calls.push(`once:${signal}`);
      handlers.set(signal, handler);
    },
    runShutdown: () => {
      shutdowns += 1;
      return Promise.resolve();
    },
    order: REGISTRATION_ORDER,
    createAction: (name: ActionName) => {
      calls.push(`create:${name}`);
      return ACTION_IDS[name];
    },
    registerAction: (action) => {
      calls.push(`register:${action}`);
    },
    connect: () => {
      calls.push("connect");
      return Promise.resolve();
    },
    startFeed: () => {
      calls.push("startFeed");
      return Promise.resolve();
    },
    logStartFailed: () => {
      calls.push("logStartFailed");
    },
    ...overrides,
  };
  return { deps, calls, handlers, shutdowns: () => shutdowns };
}

/**
 * The registration order of plugin.ts before M11a, pinned on its own so a
 * reordering of REGISTRATION_ORDER is noticed. The E1 action ("agent") was
 * removed at the user's request (2026-11-25); the other five keep their order.
 */
const HISTORICAL_ORDER: readonly ActionName[] = [
  "workspace",
  "slot",
  "pages",
  "usage",
  "attention",
];

const registrations = HISTORICAL_ORDER.flatMap((name) => [
  `create:${name}`,
  `register:${ACTION_IDS[name]}`,
]);

describe("action registration list", () => {
  it("gives every action a Property Inspector: Workspace its own page, the others the connection page (C4b)", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(
        new URL("../../local.paseocontrol.e1spike.sdPlugin/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(typeof manifest === "object" && manifest !== null && "Actions" in manifest);
    const actions: unknown = manifest.Actions;
    assert.ok(Array.isArray(actions));
    const paths = actions.map((action: unknown): [unknown, unknown] => {
      assert.ok(typeof action === "object" && action !== null);
      return [Reflect.get(action, "UUID"), Reflect.get(action, "PropertyInspectorPath")];
    });
    assert.equal(paths.length, 5);
    for (const [uuid, path] of paths) {
      assert.equal(
        path,
        uuid === ACTION_IDS.workspace ? "ui/workspace.html" : "ui/connection.html",
        String(uuid),
      );
    }
  });

  it("the E1 action is gone from the manifest and the registration; five actions keep their UUIDs", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(
        new URL("../../local.paseocontrol.e1spike.sdPlugin/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(typeof manifest === "object" && manifest !== null && "Actions" in manifest);
    const actions: unknown = manifest.Actions;
    assert.ok(Array.isArray(actions));
    const uuids = actions.map((action: unknown) => {
      if (typeof action !== "object" || action === null) return null;
      const uuid: unknown = Reflect.get(action, "UUID");
      return uuid;
    });
    const five = [
      "local.paseocontrol.e1spike.workspace",
      "local.paseocontrol.e1spike.usage",
      "local.paseocontrol.e1spike.attention",
      "local.paseocontrol.e1spike.pages",
      "local.paseocontrol.e1spike.slot",
    ];
    assert.deepEqual(uuids, five, "manifest order and UUIDs of the remaining actions");
    assert.deepEqual(REGISTRATION_ORDER.map((name) => ACTION_IDS[name]).sort(), [...five].sort());
    assert.equal(JSON.stringify(manifest).includes("e1spike.agent"), false);
    assert.equal(JSON.stringify(manifest).includes("imgs/actions/agent"), false);
  });

  it("the first dial is named Paseo project while its UUID stays, so existing profiles keep it (P2)", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(
        new URL("../../local.paseocontrol.e1spike.sdPlugin/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(typeof manifest === "object" && manifest !== null && "Actions" in manifest);
    const actions: unknown = manifest.Actions;
    assert.ok(Array.isArray(actions));
    const dial: unknown = actions.find(
      (action: unknown) =>
        typeof action === "object" &&
        action !== null &&
        Reflect.get(action, "UUID") === ACTION_IDS.workspace,
    );
    assert.ok(typeof dial === "object" && dial !== null, "the UUID is unchanged");
    assert.equal(ACTION_IDS.workspace, "local.paseocontrol.e1spike.workspace");
    assert.equal(Reflect.get(dial, "Name"), "Paseo project");
    assert.deepEqual(Reflect.get(Reflect.get(dial, "Encoder"), "TriggerDescription"), {
      Rotate: "Preview a project",
      Push: "Show the previewed project",
    });
  });

  it("the agent key is named Paseo agent and points to the Project dial while its UUID stays", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(
        new URL("../../local.paseocontrol.e1spike.sdPlugin/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(typeof manifest === "object" && manifest !== null && "Actions" in manifest);
    const actions: unknown = manifest.Actions;
    assert.ok(Array.isArray(actions));
    const key: unknown = actions.find(
      (action: unknown) =>
        typeof action === "object" &&
        action !== null &&
        Reflect.get(action, "UUID") === ACTION_IDS.slot,
    );
    assert.ok(typeof key === "object" && key !== null, "the UUID is unchanged");
    assert.equal(ACTION_IDS.slot, "local.paseocontrol.e1spike.slot");
    assert.equal(Reflect.get(key, "Name"), "Paseo agent");
    assert.equal(
      Reflect.get(key, "Tooltip"),
      "Shows one agent of the project chosen on the Project dial; press opens that agent.",
    );
    const text = JSON.stringify(manifest);
    assert.equal(text.includes("workspace key"), false);
    assert.equal(text.includes("Workspace dial"), false);
  });

  it("names every manifest action exactly once", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(
        new URL("../../local.paseocontrol.e1spike.sdPlugin/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(typeof manifest === "object" && manifest !== null && "Actions" in manifest);
    const actions: unknown = manifest.Actions;
    assert.ok(Array.isArray(actions));
    const uuids = actions.map((action: unknown) =>
      typeof action === "object" && action !== null && "UUID" in action ? action.UUID : null,
    );
    const registered = REGISTRATION_ORDER.map((name) => ACTION_IDS[name]);
    assert.equal(new Set(registered).size, registered.length, "no action twice");
    assert.deepEqual([...registered].sort(), [...uuids].sort());
  });
});

describe("bootstrapPlugin", () => {
  it("hooks the signals, registers each action once in order, then connects and starts the feed", async () => {
    const { deps, calls } = harness();
    await bootstrapPlugin(deps);
    assert.deepEqual(calls, [
      "once:SIGTERM",
      "once:SIGINT",
      ...registrations,
      "connect",
      "startFeed",
    ]);
  });

  it("starts the feed only after the connection succeeded", async () => {
    const connected = deferred<undefined>();
    const { deps, calls } = harness({
      connect: () => {
        calls.push("connect");
        return connected.promise;
      },
    });
    const run = bootstrapPlugin(deps);
    assert.equal(calls.at(-1), "connect", "everything before connect ran at once");
    assert.ok(!calls.includes("startFeed"));
    connected.resolve(undefined);
    await run;
    assert.equal(calls.at(-1), "startFeed");
  });

  it("a signal handler, when called, starts the shutdown", async () => {
    // The fake only records handlers: process.once semantics and the
    // shutdown's own idempotency are not exercised here.
    const { deps, handlers, shutdowns } = harness();
    await bootstrapPlugin(deps);
    assert.deepEqual([...handlers.keys()], ["SIGTERM", "SIGINT"]);
    handlers.get("SIGTERM")?.();
    assert.equal(shutdowns(), 1);
    handlers.get("SIGINT")?.();
    assert.equal(shutdowns(), 2);
  });

  it("a failed connection never starts the feed and logs the fixed code", async () => {
    const { deps, calls } = harness({
      connect: () => {
        calls.push("connect");
        return Promise.reject(new Error("raw connect detail"));
      },
    });
    await bootstrapPlugin(deps);
    assert.deepEqual(calls.slice(-2), ["connect", "logStartFailed"]);
    assert.ok(!calls.includes("startFeed"));
  });

  it("a failed feed start logs only the fixed code", async () => {
    const { deps, calls } = harness({
      startFeed: () => {
        calls.push("startFeed");
        return Promise.reject(new Error("raw feed detail"));
      },
    });
    await bootstrapPlugin(deps);
    assert.deepEqual(calls.slice(-3), ["connect", "startFeed", "logStartFailed"]);
    assert.equal(calls.filter((call) => call === "logStartFailed").length, 1);
  });

  it("keeps registration outside the start catch: a failed registration is not swallowed", async () => {
    const { deps, calls } = harness({
      registerAction: () => {
        throw new Error("register failed");
      },
    });
    await assert.rejects(bootstrapPlugin(deps), /register failed/);
    assert.ok(!calls.includes("connect"));
    assert.ok(!calls.includes("logStartFailed"));
  });
});
