import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentAddress, AgentRecord } from "../../src/agents/agent-model.ts";
import type { AttentionFacts } from "../../src/attention/attention-view.ts";
import type { OpenOutcome } from "../../src/opener/open-agent.ts";
import {
  AttentionDials,
  type AttentionDialHandle,
  type AttentionFeedback,
} from "../../src/spike/attention-dial.ts";
import { AttentionDialEvents } from "../../src/spike/attention-dial-events.ts";
import { deferred, ManualScheduler } from "../support/fake-client.ts";
import { makeRecord, SERVER_ID } from "../support/fixtures.ts";

/**
 * The real AttentionDialEvents (M11b2b2) over the real AttentionDials and
 * StripRenderer, with fake dials whose sends wait for the test and an
 * opener the test answers. Short titles, so nothing scrolls; scrolling,
 * the list and the press guard in detail are attention-dial.test.ts's.
 * The SDK kind check (isDial) and the handle built from the SDK action
 * stay in plugin.ts's AttentionDialAction and are not exercised here.
 */

/** Synthetic agents only. */
const question = (agentId: string): AgentRecord =>
  makeRecord({
    agentId,
    title: `Agent ${agentId}`,
    status: "running",
    pendingPermissionKinds: ["question"],
  });
const address = (agentId: string): AgentAddress => ({ serverId: SERVER_ID, agentId });

/** A dial whose sends wait for the test, and that counts its alerts. */
class FakeDial implements AttentionDialHandle {
  readonly id: string;
  readonly values: string[] = [];
  alerts = 0;
  private readonly pending: {
    done: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];
  constructor(id: string) {
    this.id = id;
  }
  setFeedback(payload: AttentionFeedback): Promise<void> {
    this.values.push(payload.value.value);
    let resolve: () => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const done = new Promise<void>((onAccept, onFail) => {
      resolve = onAccept;
      reject = onFail;
    });
    this.pending.push({ done, resolve, reject });
    return done;
  }
  showAlert(): Promise<void> {
    this.alerts += 1;
    return Promise.resolve();
  }
  /**
   * Settles the oldest waiting send and waits for that same promise. The
   * StripRenderer awaited it first, so its bookkeeping (accepted or failed)
   * is done when this returns: promise reactions run in order.
   */
  async settle(outcome: "accept" | "fail"): Promise<void> {
    const send = this.pending.shift();
    assert.ok(send, `${this.id} had a send waiting`);
    if (outcome === "accept") send.resolve();
    else send.reject(new Error("raw feedback error"));
    await send.done.catch(() => undefined);
  }
  get waiting(): number {
    return this.pending.length;
  }
}

function setup(agents: AgentRecord[] = [question("a"), question("b")]) {
  let facts: AttentionFacts = {
    connection: "ok",
    link: "connected",
    stale: false,
    failure: null,
    ready: true,
    serverId: SERVER_ID,
    agents,
    truncated: false,
  };
  const lines: string[] = [];
  const opens: { address: AgentAddress; outcome: ReturnType<typeof deferred<OpenOutcome>> }[] = [];
  let shuttingDown = false;
  const dials = new AttentionDials({
    timers: new ManualScheduler(),
    facts: () => facts,
    log: (code) => lines.push(`warn:${code}`),
  });
  const events = new AttentionDialEvents({
    dials,
    shutdownStarted: () => shuttingDown,
    open: (target) => {
      const outcome = deferred<OpenOutcome>();
      opens.push({ address: target, outcome });
      return outcome.promise;
    },
    log: (line) => lines.push(line),
  });
  return {
    events,
    dials,
    lines,
    opens,
    setFacts: (next: Partial<AttentionFacts>) => {
      facts = { ...facts, ...next };
      dials.refresh();
    },
    beginShutdown: () => {
      shuttingDown = true;
    },
  };
}

// Never needed to pass: a broken controller can leave a send or an open
// no test answers, and this turns that endless wait into a failure.
const HANG_LIMIT = { timeout: 10_000 };

describe("AttentionDialEvents", HANG_LIMIT, () => {
  it("after shutdown began no dial appears, and its press does nothing", async () => {
    const { events, dials, lines, opens, beginShutdown } = setup();
    beginShutdown();
    const dial = new FakeDial("d");
    events.appeared(dial);
    await events.pressed(dial);
    assert.deepEqual(
      [dials.count, dial.waiting, opens.length, lines, dial.alerts],
      [0, 0, 0, [], 0],
    );
  });

  it("an unknown dial and a dial with nothing to open do nothing on press", async () => {
    const { events, lines, opens } = setup([]);
    const unknown = new FakeDial("unknown");
    events.rotated("unknown", 1);
    await events.pressed(unknown);
    const empty = new FakeDial("empty");
    events.appeared(empty);
    await empty.settle("accept");
    await events.pressed(empty);
    assert.deepEqual(
      [opens.length, lines, unknown.alerts, empty.alerts, empty.waiting],
      [0, [], 0, 0, 0],
    );
  });

  it("opens the agent on the accepted strip; feedback waits for the opener", async () => {
    const { events, lines, opens } = setup();
    const dial = new FakeDial("d");
    events.appeared(dial);
    await dial.settle("accept");
    const press = events.pressed(dial);
    assert.deepEqual(
      opens.map((open) => open.address),
      [address("a")],
    );
    assert.deepEqual([lines, dial.alerts], [[], 0], "nothing before the opener answers");
    opens[0]?.outcome.resolve("requested");
    await press;
    assert.deepEqual([lines, dial.alerts], [["attention dial: open_requested"], 0]);
  });

  it("an opener failure is logged by its fixed code and alerts", async () => {
    const { events, lines, opens } = setup();
    const dial = new FakeDial("d");
    events.appeared(dial);
    await dial.settle("accept");
    const press = events.pressed(dial);
    opens[0]?.outcome.resolve("launch_failed");
    await press;
    assert.deepEqual([lines, dial.alerts], [["attention dial: open_launch_failed"], 1]);
  });

  it("a turned strip still being sent refuses without opening; once accepted it opens", async () => {
    const { events, lines, opens } = setup();
    const dial = new FakeDial("d");
    events.appeared(dial);
    await dial.settle("accept");
    events.rotated("d", 1);
    // Checked before waiting: a press that opened would wait for the opener.
    const refused = events.pressed(dial);
    assert.equal(opens.length, 0, "no open while the turned strip is being sent");
    await refused;
    assert.deepEqual([opens.length, lines, dial.alerts], [0, ["attention dial: press_refused"], 1]);
    await dial.settle("accept");
    assert.equal(dial.values.at(-1), "Agent b");
    const press = events.pressed(dial);
    assert.deepEqual(
      opens.map((open) => open.address),
      [address("b")],
      "the last accepted agent",
    );
    opens[0]?.outcome.resolve("requested");
    await press;
    assert.equal(dial.waiting, 0);
  });

  it("a failed send refuses the press; no raw error is logged", async () => {
    const { events, lines, opens } = setup();
    const dial = new FakeDial("d");
    events.appeared(dial);
    await dial.settle("fail");
    await events.pressed(dial);
    assert.equal(opens.length, 0);
    assert.deepEqual(lines, ["warn:attention_feedback_failed", "attention dial: press_refused"]);
    assert.equal(dial.alerts, 1);
    // The refused press redraws the same strip; it is sent again.
    await dial.settle("accept");
    assert.equal(dial.waiting, 0);
  });

  it("a dial that disappeared does nothing on press", async () => {
    const { events, dials, lines, opens } = setup();
    const dial = new FakeDial("d");
    events.appeared(dial);
    await dial.settle("accept");
    events.disappeared("d");
    const ignored = events.pressed(dial);
    assert.equal(opens.length, 0, "a gone dial opens nothing");
    await ignored;
    assert.deepEqual([dials.count, opens.length, lines, dial.alerts], [0, 0, [], 0]);
  });
});
