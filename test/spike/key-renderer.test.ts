import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyRenderer, type DrawKey } from "../../src/spike/key-renderer.ts";
import type { KeyView } from "../../src/spike/key-view.ts";

const A = { serverId: "srv_TestServer01", agentId: "agent-a" };
const view = (lines: string[], identity: typeof A | null = A, retry = false): KeyView => ({
  identity,
  retry,
  footerOffset: 0,
  titleOffset: 0,
  face: { kind: "message", icon: "dots", lines, alert: false },
});
const text = (v: KeyView): string => (v.face.kind === "message" ? v.face.lines.join("|") : "");

/**
 * Fake key mirroring the plugin's draw: setImage (held on a gate) then
 * setTitle only while the renderer is current. Several renderers can share
 * one key, as when the same Stream Deck context disappears and reappears.
 */
function fakeKey() {
  const calls: string[] = [];
  const gates: (() => void)[] = [];
  let failNext = false;
  const drawFor =
    (name: string): DrawKey =>
    async (v, isCurrent) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      if (failNext) {
        failNext = false;
        throw new Error("draw failed");
      }
      calls.push(`${name} image ${text(v)}`);
      if (isCurrent()) calls.push(`${name} title ${text(v)}`);
    };
  return {
    calls,
    drawFor,
    release() {
      gates.shift()?.();
    },
    failNextDraw() {
      failNext = true;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("KeyRenderer", () => {
  it("draws one view at a time and replaces undrawn older views with the newest", async () => {
    const key = fakeKey();
    const renderer = new KeyRenderer(key.drawFor("r"));
    const first = renderer.show(view(["1"]));
    void renderer.show(view(["2"]));
    void renderer.show(view(["3"]));
    key.release();
    await settle();
    key.release();
    await first;
    assert.deepEqual(key.calls, ["r image 1", "r title 1", "r image 3", "r title 3"]);
  });

  it("skips a view equal to the latest one", async () => {
    let draws = 0;
    const renderer = new KeyRenderer(() => {
      draws += 1;
      return Promise.resolve();
    });
    await renderer.show(view(["x"]));
    await renderer.show(view(["x"]));
    assert.equal(draws, 1);
  });

  it("tracks the drawn identity and pending identity changes", async () => {
    const key = fakeKey();
    const renderer = new KeyRenderer(key.drawFor("r"));
    const showing = renderer.show(view(["a"]));
    assert.equal(renderer.pressChangePending, true, "null -> A not yet drawn");
    key.release();
    await showing;
    assert.deepEqual(renderer.renderedIdentity, A);
    assert.equal(renderer.pressChangePending, false);

    const statusOnly = renderer.show(view(["a", "stale"]));
    assert.equal(renderer.pressChangePending, false, "same identity, only text changes");
    key.release();
    await statusOnly;
  });

  it("reports a pending change when the in-flight draw clears the identity even if A is queued", async () => {
    const key = fakeKey();
    const renderer = new KeyRenderer(key.drawFor("r"));
    const first = renderer.show(view(["a"]));
    key.release();
    await first;
    const clearing = renderer.show(view(["none"], null));
    void renderer.show(view(["a", "again"]));
    assert.equal(renderer.pressChangePending, true, "in-flight null must not be masked");
    key.release();
    await settle();
    key.release();
    await clearing;
    assert.equal(renderer.pressChangePending, false);
  });

  it("reports a pending change when Retry appears or disappears, and the drawn Retry offer", async () => {
    const key = fakeKey();
    const renderer = new KeyRenderer(key.drawFor("r"));
    const error = renderer.show(view(["error"], null, true));
    assert.equal(renderer.pressChangePending, true, "Retry not drawn yet");
    assert.equal(renderer.renderedRetry, false);
    key.release();
    await error;
    assert.equal(renderer.renderedRetry, true);
    assert.equal(renderer.pressChangePending, false);

    const connecting = renderer.show(view(["connecting"], null, false));
    assert.equal(renderer.pressChangePending, true, "the drawn Retry is about to go away");
    assert.equal(renderer.renderedRetry, true, "still the last completed draw");
    key.release();
    await connecting;
    assert.equal(renderer.renderedRetry, false);
    assert.equal(renderer.pressChangePending, false);
  });

  it("forgets the drawn identity when a draw fails", async () => {
    const key = fakeKey();
    const renderer = new KeyRenderer(key.drawFor("r"));
    const ok = renderer.show(view(["a"]));
    key.release();
    await ok;
    key.failNextDraw();
    const failing = renderer.show(view(["b"]));
    key.release();
    await failing;
    assert.equal(renderer.renderedIdentity, null);
  });

  it("stops after dispose: no title after an in-flight image, no queued draw", async () => {
    const key = fakeKey();
    const renderer = new KeyRenderer(key.drawFor("old"));
    const showing = renderer.show(view(["1"]));
    void renderer.show(view(["2"]));
    renderer.dispose();
    key.release();
    await showing;
    assert.deepEqual(key.calls, ["old image 1"]);
    assert.equal(renderer.renderedIdentity, null);
    assert.equal(renderer.pressChangePending, false);
    await renderer.show(view(["3"]));
    assert.deepEqual(key.calls, ["old image 1"]);
  });

  it("lets a reappearing key's new renderer win over the old one's late draw", async () => {
    const key = fakeKey();
    const old = new KeyRenderer(key.drawFor("old"));
    const oldShowing = old.show(view(["stale"]));
    old.dispose();
    const fresh = new KeyRenderer(key.drawFor("new"));
    const freshShowing = fresh.show(view(["fresh"]));
    key.release();
    key.release();
    await Promise.all([oldShowing, freshShowing]);
    assert.deepEqual(key.calls, ["old image stale", "new image fresh", "new title fresh"]);
    assert.deepEqual(fresh.renderedIdentity, A);
    assert.equal(old.renderedIdentity, null);
  });
});
