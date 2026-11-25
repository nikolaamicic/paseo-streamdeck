import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StripText, StripView } from "../../src/navigation/navigation.ts";
import { StripRenderer } from "../../src/spike/strip-renderer.ts";
import { deferred, flush } from "../support/fake-client.ts";

const view = (value: string, preview: string | null = null): StripView => ({
  text: { label: { value: "Workspace", color: "#a6a6ae" }, value, hint: "" },
  preview,
});

class Sends {
  readonly calls: { text: StripText; done: ReturnType<typeof deferred<undefined>> }[] = [];
  errors = 0;

  readonly renderer = new StripRenderer(
    (text) => {
      const done = deferred<undefined>();
      this.calls.push({ text, done });
      return done.promise;
    },
    () => {
      this.errors += 1;
    },
  );

  private settledCount = 0;

  /** Resolves the oldest unsettled send. */
  async settle(): Promise<void> {
    const call = this.calls[this.settledCount];
    assert.ok(call, "a send is pending");
    this.settledCount += 1;
    call.done.resolve(undefined);
    await flush();
  }
}

describe("StripRenderer", () => {
  it("sends one at a time, coalesces to the newest view and skips unchanged ones", async () => {
    const sends = new Sends();
    void sends.renderer.show(view("A"));
    void sends.renderer.show(view("B"));
    void sends.renderer.show(view("C"));
    assert.equal(sends.calls.length, 1, "one in flight");
    await sends.settle();
    assert.deepEqual(
      sends.calls.map((call) => call.text.value),
      ["A", "C"],
      "B was replaced before it was sent",
    );
    await sends.settle();
    void sends.renderer.show(view("C"));
    assert.equal(sends.calls.length, 2, "unchanged view not resent");
  });

  it("reports a preview only once its strip was accepted and nothing pending changes it", async () => {
    const sends = new Sends();
    void sends.renderer.show(view("All"));
    assert.equal(sends.renderer.shown, null, "nothing accepted yet");
    await sends.settle();
    assert.deepEqual(sends.renderer.shown, { preview: null }, "accepted, without a preview");
    void sends.renderer.show(view("main", "k1"));
    assert.equal(sends.renderer.shown, null, "the preview is still in flight");
    await sends.settle();
    assert.deepEqual(sends.renderer.shown, { preview: "k1" });
    void sends.renderer.show(view("feature", "k2"));
    assert.equal(sends.renderer.shown, null, "a different preview is pending");
  });

  it("forgets what is shown after a failed send and ignores completions after dispose", async () => {
    const failing = new StripRenderer(
      () => Promise.reject(new Error("raw")),
      () => undefined,
    );
    await failing.show(view("main", "k1"));
    assert.equal(failing.shown, null);

    const sends = new Sends();
    void sends.renderer.show(view("main", "k1"));
    sends.renderer.dispose();
    await sends.settle();
    assert.equal(sends.renderer.shown, null, "a late completion certifies nothing");
    void sends.renderer.show(view("x", "k2"));
    assert.equal(sends.calls.length, 1, "nothing is sent after dispose");
  });
});
