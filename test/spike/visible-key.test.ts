import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FOOTER_SCROLL } from "../../src/spike/footer-scroll.ts";
import { slotKeyView } from "../../src/spike/key-view.ts";
import { createVisibleKey, presentKey } from "../../src/spike/visible-key.ts";
import { flush, ManualScheduler } from "../support/fake-client.ts";
import { makeRecord, SERVER_ID } from "../support/fixtures.ts";

class FakeKeyAction {
  readonly images: string[] = [];

  setImage(image: string): Promise<void> {
    this.images.push(image);
    return Promise.resolve();
  }

  setTitle(): Promise<void> {
    return Promise.resolve();
  }
}

const record = makeRecord({
  project: { key: "p", name: "a project name far too long for one key footer line" },
});
const longFooterView = slotKeyView({
  connection: "ok",
  link: "connected",
  stale: false,
  failure: null,
  recoveryError: null,
  retryAvailable: false,
  serverId: SERVER_ID,
  hasSnapshot: true,
  dimmed: false,
  slot: record.address,
  record,
});

async function framesAfterPresent(
  build: (
    action: FakeKeyAction,
    clock: ManualScheduler,
  ) => {
    key: Parameters<typeof presentKey>[0];
  },
): Promise<number> {
  const action = new FakeKeyAction();
  const clock = new ManualScheduler();
  const { key } = build(action, clock);
  void presentKey(key, longFooterView);
  await flush();
  const first = action.images.length;
  clock.advance(FOOTER_SCROLL.pauseMs + 3 * FOOTER_SCROLL.frameMs);
  await flush();
  return action.images.length - first;
}

describe("createVisibleKey", () => {
  it("scrolls a long footer on a workspace key built like the plugin builds it", async () => {
    // Same call as SlotKeyAction: extra fields go through the factory.
    const frames = await framesAfterPresent((action, clock) => ({
      key: createVisibleKey(action, clock, { deviceId: "dev", slot: 3 }),
    }));
    assert.ok(frames > 0, "footer frames are drawn after present()");
  });

  it("documents the defect: a spread copy leaves the frames reading a stale base", async () => {
    const frames = await framesAfterPresent((action, clock) => ({
      key: { ...createVisibleKey(action, clock, {}), deviceId: "dev", slot: 3 },
    }));
    assert.equal(frames, 0);
  });
});

describe("presentKey: long agent titles", () => {
  const view = (title: string) => {
    const agent = makeRecord({ title, project: { key: "p", name: "app" } });
    return slotKeyView({
      connection: "ok",
      link: "connected",
      stale: false,
      failure: null,
      recoveryError: null,
      retryAvailable: false,
      serverId: SERVER_ID,
      hasSnapshot: true,
      dimmed: false,
      slot: agent.address,
      record: agent,
    });
  };

  it("scrolls a long title's second line without changing what a press opens", async () => {
    const action = new FakeKeyAction();
    const clock = new ManualScheduler();
    const key = createVisibleKey(action, clock, { deviceId: "dev", slot: 0 });
    void presentKey(key, view("Refactor the login flow and the session expiry handling"));
    await flush();
    const first = action.images.length;
    const identity = key.renderer.renderedIdentity;
    assert.ok(identity);
    clock.advance(FOOTER_SCROLL.pauseMs + 3 * FOOTER_SCROLL.frameMs);
    await flush();
    assert.ok(action.images.length > first, "title frames are drawn");
    assert.deepEqual(key.renderer.renderedIdentity, identity, "same agent after the frames");
    assert.equal(key.renderer.pressChangePending, false, "frames never block or redirect a press");
    assert.match(decodeURIComponent(action.images.at(-1) ?? ""), /fadeLeftTitle/);
    key.scroller.dispose();
    assert.equal(clock.pendingTimers, 0, "dispose stops the clock");
  });

  it("keeps a short title and short footer still: no timer", async () => {
    const action = new FakeKeyAction();
    const clock = new ManualScheduler();
    const key = createVisibleKey(action, clock, {});
    void presentKey(key, view("Fix tests"));
    await flush();
    assert.equal(clock.pendingTimers, 0);
  });
});
