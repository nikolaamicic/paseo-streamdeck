import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAddress, AgentRecord } from "../../src/agents/agent-model.ts";
import type { SlotState } from "../../src/navigation/navigation.ts";
import type { OpenOutcome } from "../../src/opener/open-agent.ts";
import {
  KeyController,
  type KeyControllerDeps,
  type SlotKeyHandle,
} from "../../src/spike/key-controller.ts";
import { slotKeyView, type KeyView } from "../../src/spike/key-view.ts";
import { ManualScheduler } from "../support/fake-client.ts";
import { makeRecord, SERVER_ID } from "../support/fixtures.ts";

/**
 * The real KeyController (M11b2a) with fake key handles whose setImage
 * waits for the test, the real KeyRenderer and TextScroller, and a manual
 * clock. The SDK kind checks (isKey, isInMultiAction) stay in plugin.ts's
 * action classes and are not exercised here.
 */

const A: AgentAddress = { serverId: SERVER_ID, agentId: "agent-a" };
const B: AgentAddress = { serverId: SERVER_ID, agentId: "agent-b" };
const LONG = "A very long agent title that keeps scrolling on the second line of the key";
const records = new Map<string, AgentRecord>([
  ["agent-a", makeRecord({ agentId: "agent-a", title: LONG })],
  ["agent-b", makeRecord({ agentId: "agent-b" })],
]);

const FEED = {
  connection: "ok" as const,
  link: "connected" as const,
  stale: false,
  failure: null,
  recoveryError: null,
  retryAvailable: false,
  serverId: SERVER_ID,
  hasSnapshot: true,
  dimmed: false,
};
const viewOf = (address: AgentAddress): KeyView =>
  slotKeyView({ ...FEED, slot: address, record: records.get(address.agentId) });

/** A key action whose image writes wait for the test. */
class FakeKey implements SlotKeyHandle {
  readonly id: string;
  readonly deviceId = "dev";
  readonly coordinates: { column: number; row: number } | undefined;
  readonly images: string[] = [];
  readonly feedback: string[] = [];
  private readonly gates: (() => void)[] = [];
  constructor(id: string, coordinates?: { column: number; row: number }) {
    this.id = id;
    this.coordinates = coordinates;
  }
  setImage(image: string): Promise<void> {
    this.images.push(image);
    return new Promise((resolve) => this.gates.push(resolve));
  }
  setTitle(): Promise<void> {
    return Promise.resolve();
  }
  showAlert(): Promise<void> {
    this.feedback.push("alert");
    return Promise.resolve();
  }
  showOk(): Promise<void> {
    this.feedback.push("ok");
    return Promise.resolve();
  }
  /** Accepts the image write that is waiting; returns false when none is. */
  accept(): boolean {
    const gate = this.gates.shift();
    gate?.();
    return gate !== undefined;
  }
  get waiting(): number {
    return this.gates.length;
  }
}

function setup(overrides: Partial<KeyControllerDeps> = {}) {
  const clock = new ManualScheduler();
  const opened: AgentAddress[] = [];
  const calls: string[] = [];
  let placed: SlotState = { kind: "agent", address: B, dimmed: false };
  let shuttingDown = false;
  const deps: KeyControllerDeps = {
    timers: clock,
    shutdownStarted: () => shuttingDown,
    slotState: (deviceId, slot) => {
      calls.push(`slotState:${deviceId}:${String(slot)}`);
      return placed;
    },
    slotView: (deviceId, slot) => {
      calls.push(`slotView:${deviceId}:${String(slot)}`);
      return placed.kind === "agent" ? viewOf(placed.address) : viewOf(A);
    },
    useDevice: (deviceId) => calls.push(`useDevice:${deviceId}`),
    renderAll: () => calls.push("renderAll"),
    isPresent: () => true,
    retryNow: () => false,
    open: (address): Promise<OpenOutcome> => {
      opened.push(address);
      return Promise.resolve("requested");
    },
    log: () => undefined,
    ...overrides,
  };
  return {
    clock,
    opened,
    calls,
    controller: new KeyController(deps),
    place: (state: SlotState) => {
      placed = state;
    },
    beginShutdown: () => {
      shuttingDown = true;
    },
  };
}

/** Accepts the waiting write of each key, then waits for the draws to finish. */
async function drawn(done: Promise<void>, ...keys: FakeKey[]): Promise<void> {
  for (const key of keys) assert.ok(key.accept(), `${key.id} had a write waiting`);
  await done;
}

/*
 * The agent keys. The separate E1 key was removed at the user's request
 * (2026-11-25); its cases (ownership per controller, a reappearing key,
 * disappearing, shutdown and dispose) now run on agent keys.
 */
describe("KeyController: agent keys", () => {
  it("two controllers keep their own keys", async () => {
    const first = setup();
    // Same placement: only who owns the key differs.
    const second = setup();
    const key = new FakeKey("k", { column: 0, row: 0 });
    first.controller.slotAppeared(key);
    await drawn(first.controller.presentSlotKeys(), key);
    await second.controller.slotPressed(key);
    assert.deepEqual([second.opened, key.feedback], [[], ["alert"]], "unknown to the second");
    await first.controller.slotPressed(key);
    assert.deepEqual(first.opened, [B]);
  });

  it("a workspace key registers its device, redraws, and uses its grid slot", async () => {
    const { controller, calls } = setup();
    const key = new FakeKey("slot", { column: 2, row: 1 });
    controller.slotAppeared(key);
    assert.deepEqual(calls, ["useDevice:dev", "renderAll"]);
    const done = controller.presentSlotKeys();
    assert.equal(calls.at(-1), "slotView:dev:6");
    await drawn(done, key);
    await controller.slotPressed(key);
    assert.equal(calls.at(-1), "slotState:dev:6");
  });

  it("a press uses the last accepted draw, not the new placement", async () => {
    const { controller, opened, place } = setup();
    const key = new FakeKey("slot", { column: 0, row: 0 });
    place({ kind: "agent", address: B, dimmed: false });
    controller.slotAppeared(key);
    await drawn(controller.presentSlotKeys(), key);
    place({ kind: "empty" });
    await controller.slotPressed(key);
    assert.deepEqual(opened, [], "B is drawn but the slot is empty now");
    place({ kind: "agent", address: A, dimmed: false });
    const toA = controller.presentSlotKeys();
    await controller.slotPressed(key);
    assert.deepEqual(opened, [], "A is being drawn");
    await drawn(toA, key);
    await controller.slotPressed(key);
    assert.deepEqual(opened, [A]);
  });

  it("a reappearing key replaces the old one, whose late write counts for nothing", async () => {
    const { controller, opened, clock, place } = setup();
    place({ kind: "agent", address: A, dimmed: false });
    const old = new FakeKey("k", { column: 0, row: 0 });
    controller.slotAppeared(old);
    const oldDone = controller.presentSlotKeys();
    const fresh = new FakeKey("k", { column: 0, row: 0 });
    controller.slotAppeared(fresh);
    const freshDone = controller.presentSlotKeys();
    await drawn(oldDone, old);
    await controller.slotPressed(fresh);
    assert.deepEqual(opened, [], "the old key's completed write does not count");
    await drawn(freshDone, fresh);
    assert.equal(clock.pendingTimers, 1, "only the fresh key's scroller runs");
    await controller.slotPressed(fresh);
    assert.deepEqual(opened, [A]);
  });

  it("a key that disappears stops scrolling, and a press finds nothing", async () => {
    const { controller, opened, clock, place } = setup();
    place({ kind: "agent", address: A, dimmed: false });
    const key = new FakeKey("k", { column: 0, row: 0 });
    controller.slotAppeared(key);
    await drawn(controller.presentSlotKeys(), key);
    assert.ok(clock.pendingTimers > 0, "the long title scrolls");
    controller.slotDisappeared("k");
    assert.equal(clock.pendingTimers, 0);
    await controller.slotPressed(key);
    assert.deepEqual(opened, []);
  });

  it("after shutdown began no key appears", async () => {
    const { controller, calls, clock, opened, beginShutdown } = setup();
    beginShutdown();
    const slot = new FakeKey("slot", { column: 0, row: 0 });
    controller.slotAppeared(slot);
    await controller.presentSlotKeys();
    assert.equal(clock.pendingTimers, 0, "nothing started scrolling");
    assert.deepEqual(calls, [], "no device registered, no redraw");
    await controller.slotPressed(slot);
    assert.deepEqual([opened, slot.waiting], [[], 0]);
  });

  it("dispose stops every key and forgets it", async () => {
    const { controller, opened, clock, place } = setup();
    place({ kind: "agent", address: A, dimmed: false });
    const slot = new FakeKey("slot", { column: 0, row: 0 });
    controller.slotAppeared(slot);
    await drawn(controller.presentSlotKeys(), slot);
    controller.dispose();
    assert.equal(clock.pendingTimers, 0);
    await controller.slotPressed(slot);
    assert.deepEqual(opened, []);
    await controller.presentSlotKeys();
    assert.equal(slot.waiting, 0, "nothing more is drawn");
  });
});
