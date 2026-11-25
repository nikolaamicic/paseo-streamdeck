import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAddress, AgentRecord } from "../../src/agents/agent-model.ts";
import type { OpenOutcome } from "../../src/opener/open-agent.ts";
import {
  handleKeyPress,
  slotFromCoordinates,
  slotPressTarget,
  type RenderedKey,
} from "../../src/spike/key-press.ts";
import { KeyRenderer } from "../../src/spike/key-renderer.ts";
import { slotKeyView, type KeyView } from "../../src/spike/key-view.ts";
import { deferred } from "../support/fake-client.ts";
import { makeRecord, SERVER_ID } from "../support/fixtures.ts";

/**
 * Characterization of the key press wiring that plugin.ts runs (M3): slot
 * coordinates, the press target of a workspace key, and handleKeyPress with
 * the real KeyRenderer and key views. Opening, retry and the Stream Deck
 * action are fakes; nothing is opened and no device is used. Each draw is
 * held by a gate the test settles; every started show() is awaited.
 */

const A: AgentAddress = { serverId: SERVER_ID, agentId: "agent-a" };
const B: AgentAddress = { serverId: SERVER_ID, agentId: "agent-b" };
const records = new Map<string, AgentRecord>(
  [A, B].map((address) => [address.agentId, makeRecord({ agentId: address.agentId })]),
);

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

/** The view a workspace key shows for an agent, as plugin.ts builds it. */
const agentView = (address: AgentAddress): KeyView =>
  slotKeyView({ ...FEED, slot: address, record: records.get(address.agentId) });

/** Before the first data, with or without a recovery attempt offered. */
const waitingView = (retryAvailable: boolean): KeyView =>
  slotKeyView({
    ...FEED,
    hasSnapshot: false,
    failure: retryAvailable ? "connect_failed" : null,
    link: retryAvailable ? "connected" : "connecting",
    retryAvailable,
    slot: "loading",
    record: undefined,
  });

interface Gate {
  readonly resolve: () => void;
  readonly reject: () => void;
}

/**
 * A renderer whose draws wait for the test. KeyRenderer.show() calls the
 * draw before its first await, so the gate exists as soon as show() returns.
 */
function gatedRenderer() {
  const gates: Gate[] = [];
  const renderer = new KeyRenderer(
    () =>
      new Promise<void>((resolve, reject) => {
        gates.push({
          resolve,
          reject: () => {
            reject(new Error("draw failed"));
          },
        });
      }),
  );
  /** Starts drawing `view`; returns the show() promise and its draw gate. */
  const start = (view: KeyView) => {
    const shown = renderer.show(view);
    const gate = gates.shift();
    assert.ok(gate, "the draw started");
    return { shown, gate };
  };
  /** Draws `view` and waits until the renderer accepted it. */
  const accept = async (view: KeyView) => {
    const { shown, gate } = start(view);
    gate.resolve();
    await shown;
  };
  return { renderer, start, accept };
}

function press(
  renderer: RenderedKey | undefined,
  expected: AgentAddress | null,
  options: { present?: boolean; retry?: boolean; outcome?: OpenOutcome } = {},
) {
  const calls: string[] = [];
  const opened: AgentAddress[] = [];
  const run = handleKeyPress({
    renderer,
    expected,
    isPresent: () => options.present ?? true,
    retryNow: () => {
      calls.push("retry");
      return options.retry ?? false;
    },
    open: (address) => {
      opened.push(address);
      return Promise.resolve(options.outcome ?? "requested");
    },
    showAlert: () => {
      calls.push("alert");
      return Promise.resolve();
    },
    showOk: () => {
      calls.push("ok");
      return Promise.resolve();
    },
    log: (message) => calls.push(message),
  });
  return run.then(() => ({ calls, opened }));
}

const REFUSED_CHANGING = ["press refused: identity_changing", "alert"];

describe("slot coordinates (Stream Deck + 4 × 2)", () => {
  it("maps all eight keys to distinct slots 0–7, row by row", () => {
    const slots = [0, 1].flatMap((row) =>
      [0, 1, 2, 3].map((column) => slotFromCoordinates({ column, row })),
    );
    assert.deepEqual(slots, [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("gives -1 outside the grid and without coordinates (multi-action keys)", () => {
    for (const coordinates of [{ column: 4, row: 0 }, { column: 0, row: 2 }, undefined]) {
      assert.equal(slotFromCoordinates(coordinates), -1, JSON.stringify(coordinates));
    }
  });

  it("takes the press target only from an agent placed on the slot", () => {
    assert.deepEqual(slotPressTarget({ kind: "agent", address: A, dimmed: true }), A);
    for (const state of [{ kind: "empty" } as const, { kind: "loading" } as const, null]) {
      assert.equal(slotPressTarget(state), null);
    }
  });
});

describe("handleKeyPress with the real renderer", () => {
  it("opens the drawn, expected and present agent and confirms", async () => {
    const { renderer, accept } = gatedRenderer();
    await accept(agentView(A));
    const { calls, opened } = await press(renderer, A);
    assert.deepEqual(opened, [A]);
    assert.deepEqual(calls, ["open: requested", "ok"]);
  });

  it("refuses before the first draw is accepted and while the target changes", async () => {
    const { renderer, start, accept } = gatedRenderer();
    const first = start(agentView(A));
    const early = await press(renderer, A);
    assert.deepEqual([early.calls, early.opened], [REFUSED_CHANGING, []]);
    first.gate.resolve();
    await first.shown;

    // The slot now holds B (e.g. after a re-sort), but the key still shows A.
    const moved = await press(renderer, B);
    assert.deepEqual(moved.calls, ["press refused: not_configured", "alert"]);
    const toB = start(agentView(B));
    assert.deepEqual((await press(renderer, B)).calls, REFUSED_CHANGING);
    toB.gate.resolve();
    await toB.shown;
    assert.deepEqual((await press(renderer, B)).opened, [B]);
    await accept(agentView(A));
  });

  it("does not block on a redraw of the same agent (only a change of action blocks)", async () => {
    const { renderer, start, accept } = gatedRenderer();
    await accept(agentView(A));
    const redraw = start({ ...agentView(A), footerOffset: 8 });
    assert.equal(renderer.pressChangePending, false);
    assert.deepEqual((await press(renderer, A)).opened, [A]);
    redraw.gate.resolve();
    await redraw.shown;
  });

  it("refuses after a failed draw and after the key disappeared", async () => {
    const failed = gatedRenderer();
    const draw = failed.start(agentView(A));
    draw.gate.reject();
    await draw.shown;
    assert.deepEqual((await press(failed.renderer, A)).calls, [
      "press refused: nothing_shown",
      "alert",
    ]);

    const gone = gatedRenderer();
    await gone.accept(agentView(A));
    gone.renderer.dispose();
    assert.deepEqual((await press(gone.renderer, A)).opened, []);
  });

  it("refuses an agent that left the directory, and an unregistered key", async () => {
    const { renderer, accept } = gatedRenderer();
    await accept(agentView(A));
    assert.deepEqual((await press(renderer, A, { present: false })).calls, [
      "press refused: not_current",
      "alert",
    ]);
    // A key inside a multi-action is never registered: no renderer, no target.
    assert.deepEqual((await press(undefined, null)).calls, REFUSED_CHANGING);
  });

  it("E1 opens only its configured agent; an emptied slot opens nothing", async () => {
    const { renderer, accept } = gatedRenderer();
    await accept(agentView(A));
    assert.deepEqual((await press(renderer, B)).opened, [], "E1 configured for another agent");
    assert.deepEqual((await press(renderer, slotPressTarget({ kind: "empty" }))).opened, []);
  });

  it("asks for one retry when the drawn key offers Retry, alerting if none starts", async () => {
    const { renderer, accept } = gatedRenderer();
    await accept(waitingView(true));
    assert.equal(renderer.renderedRetry, true);
    const started = await press(renderer, null, { retry: true });
    assert.deepEqual(started.calls, ["retry", "retry: started"]);
    const busy = await press(renderer, null, { retry: false });
    assert.deepEqual(busy.calls, ["retry", "retry: not available", "alert"]);
    assert.deepEqual(busy.opened, []);
  });

  it("alerts when the opener fails", async () => {
    const { renderer, accept } = gatedRenderer();
    await accept(agentView(A));
    const result = await press(renderer, A, { outcome: "launch_failed" });
    assert.deepEqual(result.calls, ["open: launch_failed", "alert"]);
  });

  it("confirms only after the opener answers", async () => {
    const { renderer, accept } = gatedRenderer();
    await accept(agentView(A));
    const gate = deferred<OpenOutcome>();
    const calls: string[] = [];
    const run = handleKeyPress({
      renderer,
      expected: A,
      isPresent: () => true,
      retryNow: () => false,
      open: () => {
        calls.push("open");
        return gate.promise;
      },
      showAlert: () => Promise.resolve(),
      showOk: () => {
        calls.push("ok");
        return Promise.resolve();
      },
      log: () => undefined,
    });
    assert.deepEqual(calls, ["open"], "the opener was asked, nothing confirmed yet");
    gate.resolve("requested");
    await run;
    assert.deepEqual(calls, ["open", "ok"]);
  });
});

describe("handleKeyPress while the Retry offer changes", () => {
  it("drawn Retry, pending agent: neither retries nor opens until the agent is drawn", async () => {
    const { renderer, start, accept } = gatedRenderer();
    await accept(waitingView(true));
    const toAgent = start(agentView(A));
    const during = await press(renderer, A, { retry: true });
    assert.deepEqual([during.calls, during.opened], [REFUSED_CHANGING, []]);
    toAgent.gate.resolve();
    await toAgent.shown;
    const after = await press(renderer, A, { retry: true });
    assert.deepEqual([after.calls, after.opened], [["open: requested", "ok"], [A]]);
  });

  it("drawn agent, pending Retry: neither opens nor retries until Retry is drawn", async () => {
    const { renderer, start, accept } = gatedRenderer();
    await accept(agentView(A));
    const toRetry = start(waitingView(true));
    const during = await press(renderer, A, { retry: true });
    assert.deepEqual([during.calls, during.opened], [REFUSED_CHANGING, []]);
    toRetry.gate.resolve();
    await toRetry.shown;
    const after = await press(renderer, null, { retry: true });
    assert.deepEqual([after.calls, after.opened], [["retry", "retry: started"], []]);
  });

  it("only the Retry offer changes (no agent either way): the press waits for it", async () => {
    const { renderer, start, accept } = gatedRenderer();
    await accept(waitingView(false));
    const toRetry = start(waitingView(true));
    assert.equal(renderer.renderedIdentity, null);
    const during = await press(renderer, null, { retry: true });
    assert.deepEqual(during.calls, REFUSED_CHANGING, "no retry before Retry is drawn");
    toRetry.gate.resolve();
    await toRetry.shown;
    assert.deepEqual((await press(renderer, null, { retry: true })).calls, [
      "retry",
      "retry: started",
    ]);
  });
});
