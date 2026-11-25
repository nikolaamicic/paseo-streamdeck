import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRecord } from "../../src/agents/agent-model.ts";
import type { AttentionFacts } from "../../src/attention/attention-view.ts";
import { AttentionDials, type AttentionFeedback } from "../../src/spike/attention-dial.ts";
import { FOOTER_SCROLL } from "../../src/spike/footer-scroll.ts";
import { flush, ManualScheduler } from "../support/fake-client.ts";
import { makeRecord, SERVER_ID } from "../support/fixtures.ts";

const OTHER = "srv_OtherHost02";

/** Synthetic agents only. */
function question(agentId: string, more: Partial<AgentRecord> = {}): AgentRecord {
  return makeRecord({
    agentId,
    title: `Agent ${agentId}`,
    status: "running",
    pendingPermissionKinds: ["question"],
    ...more,
  });
}

/** A dial whose sends stay pending until settled. */
class GatedDial {
  readonly id: string;
  readonly pending: { payload: AttentionFeedback; settle: (ok: boolean) => void }[] = [];
  readonly sent: AttentionFeedback[] = [];
  constructor(id: string) {
    this.id = id;
  }
  setFeedback(payload: AttentionFeedback): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        payload,
        settle: (ok) => {
          if (ok) {
            this.sent.push(payload);
            resolve();
          } else reject(new Error("raw"));
        },
      });
    });
  }
  async settleAll(ok = true): Promise<void> {
    while (this.pending.length > 0) {
      this.pending.shift()?.settle(ok);
      await flush();
    }
  }
  last(): AttentionFeedback {
    const payload = this.sent.at(-1);
    assert.ok(payload, "a strip was accepted");
    return payload;
  }
}

function setup(agents: AgentRecord[] = [question("a"), question("b"), question("c")]) {
  const clock = new ManualScheduler();
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
  const logs: string[] = [];
  const dials = new AttentionDials({
    timers: clock,
    facts: () => facts,
    log: (code) => logs.push(code),
  });
  const set = (next: Partial<AttentionFacts>) => {
    facts = { ...facts, ...next };
    dials.refresh();
  };
  const opened = (id: string) => {
    const result = dials.press(id);
    return result.kind === "open"
      ? `${result.address.serverId}:${result.address.agentId}`
      : result.kind;
  };
  return { clock, dials, logs, set, opened };
}

const at = (agentId: string, serverId = SERVER_ID) => `${serverId}:${agentId}`;

describe("AttentionDials: drawing and turning", () => {
  it("sends reason in yellow, the name in white, counter and hint", async () => {
    const { dials } = setup([question("a", { project: { key: "p", name: "paseo-web" } })]);
    const dial = new GatedDial("d");
    dials.appear(dial);
    await dial.settleAll();
    assert.deepEqual(dial.last(), {
      label: { value: "Question?", color: "#FFB938" },
      counter: "1/1",
      value: { value: "Agent a", color: "#FFFFFF" },
      hint: "Press to open · paseo-web",
    });
  });

  it("turns without wrapping and keeps each dial's own agent", async () => {
    const { dials } = setup();
    const left = new GatedDial("left");
    const right = new GatedDial("right");
    dials.appear(left);
    dials.appear(right);
    assert.equal(dials.rotate("left", 5), "moved");
    assert.equal(dials.rotate("left", 1), "unchanged", "no wrap past the end");
    assert.equal(dials.rotate("left", -9), "moved");
    assert.equal(dials.rotate("left", -1), "unchanged");
    dials.rotate("left", 1);
    await left.settleAll();
    await right.settleAll();
    assert.equal(left.last().counter, "2/3");
    assert.equal(right.last().counter, "1/3");
  });

  it("follows its agent through list changes and moves to the first when it leaves", async () => {
    const { dials, set } = setup();
    const dial = new GatedDial("d");
    dials.appear(dial);
    dials.rotate("d", 1);
    await dial.settleAll();
    set({
      agents: [
        question("new", { updatedAt: "2026-11-17T00:00:00.000Z" }),
        question("a"),
        question("b"),
        question("c"),
      ],
    });
    await dial.settleAll();
    assert.deepEqual([dial.last().value.value, dial.last().counter], ["Agent b", "3/4"]);
    set({ agents: [question("a"), question("c")] });
    await dial.settleAll();
    assert.equal(dial.last().value.value, "Agent a");
  });
});

describe("AttentionDials: press opens only the accepted, current agent", () => {
  it("opens the shown agent; refuses while a turned strip is still being sent", async () => {
    const { dials, opened } = setup();
    const dial = new GatedDial("d");
    dials.appear(dial);
    assert.equal(opened("d"), "refused", "first strip not accepted yet");
    await dial.settleAll();
    assert.equal(opened("d"), at("a"));
    dials.rotate("d", 1);
    assert.equal(opened("d"), "refused", "quick turn and press");
    await dial.settleAll();
    assert.equal(opened("d"), at("b"));
  });

  it("refuses after a failed send until a new strip is accepted", async () => {
    const { dials, opened, logs } = setup();
    const dial = new GatedDial("d");
    dials.appear(dial);
    await dial.settleAll(false);
    assert.ok(logs.includes("attention_feedback_failed"));
    assert.equal(opened("d"), "refused");
    await dial.settleAll();
    assert.equal(opened("d"), at("a"), "the refusal redrew the strip");
  });

  it("does not block on a counter change for the same agent", async () => {
    const { dials, set, opened } = setup();
    const dial = new GatedDial("d");
    dials.appear(dial);
    await dial.settleAll();
    set({ agents: [question("a"), question("b"), question("c"), question("d")] });
    assert.equal(dial.pending.length, 1, "new counter in flight");
    assert.equal(opened("d"), at("a"), "same identity: the press is not blocked");
  });

  it("refuses when the shown agent left the list before the new strip is accepted", async () => {
    const { dials, set, opened } = setup();
    const dial = new GatedDial("d");
    dials.appear(dial);
    await dial.settleAll();
    set({ agents: [question("b")] });
    assert.equal(opened("d"), "refused");
    await dial.settleAll();
    assert.equal(opened("d"), at("b"));
  });

  it("never opens the previous host's agent after a host change, even with the same ID", async () => {
    const { dials, set, opened } = setup([question("a")]);
    const dial = new GatedDial("d");
    dials.appear(dial);
    await dial.settleAll();
    const foreign = { ...question("a"), address: { serverId: OTHER, agentId: "a" } };
    set({ serverId: OTHER, agents: [foreign] });
    assert.equal(opened("d"), "refused");
    await dial.settleAll();
    assert.equal(opened("d"), at("a", OTHER));
  });

  it("opens nothing while loading, before the host is known or with an empty list", async () => {
    const { dials, set, opened } = setup();
    const dial = new GatedDial("d");
    dials.appear(dial);
    await dial.settleAll();
    set({ ready: false, link: "connecting" });
    await dial.settleAll();
    assert.equal(opened("d"), "none");
    set({ ready: true, link: "connected", serverId: null });
    assert.equal(opened("d"), "none");
    set({ serverId: SERVER_ID, agents: [] });
    await dial.settleAll();
    assert.equal(opened("d"), "none");
    assert.equal(dial.last().value.value, "No alerts");
  });

  it("opens the last known agent while offline, marked as such", async () => {
    const { dials, set, opened } = setup();
    const dial = new GatedDial("d");
    dials.appear(dial);
    await dial.settleAll();
    set({ link: "reconnecting" });
    await dial.settleAll();
    assert.equal(dial.last().hint, "Offline · last known");
    assert.equal(opened("d"), at("a"));
  });

  it("does not let an old instance's late completion certify a reappeared dial", async () => {
    const { dials, opened } = setup();
    const old = new GatedDial("d");
    dials.appear(old);
    const fresh = new GatedDial("d");
    dials.appear(fresh);
    await old.settleAll();
    assert.equal(opened("d"), "refused");
    await fresh.settleAll();
    assert.equal(opened("d"), at("a"));
    dials.disappear("d");
    assert.equal(opened("d"), "none");
  });
});

describe("AttentionDials: long names", () => {
  it("scrolls a long name; a frame in flight does not block the press; timers stop", async () => {
    const long = "A very long agent title that cannot fit on the touch strip at all";
    const { clock, dials, opened } = setup([question("a", { title: long })]);
    const dial = new GatedDial("d");
    dials.appear(dial);
    await dial.settleAll();
    clock.advance(FOOTER_SCROLL.pauseMs + 20 * FOOTER_SCROLL.frameMs);
    assert.ok(dial.pending.length > 0, "a scroll frame is being sent");
    assert.equal(opened("d"), at("a"), "scrolling keeps the identity");
    await dial.settleAll();
    clock.advance(20 * FOOTER_SCROLL.frameMs);
    await dial.settleAll();
    const first = dial.sent[0]?.value.value ?? "";
    assert.ok(
      dial.sent.some((sent) => sent.value.value.length < first.length),
      "the name moved further in",
    );
    await dial.settleAll();
    dials.disappear("d");
    assert.equal(clock.pendingTimers, 0);
  });
});

describe("AttentionDials: scroll restarts on another agent", () => {
  it("restarts from the start pause for a different agent with the same title", async () => {
    const long = "The same very long agent title shown for two different agents here";
    const { clock, dials } = setup([
      question("a", { title: long }),
      question("b", { title: long }),
    ]);
    const dial = new GatedDial("d");
    dials.appear(dial);
    await dial.settleAll();
    const start = dial.last().value.value;
    clock.advance(FOOTER_SCROLL.pauseMs + 40 * FOOTER_SCROLL.frameMs);
    await dial.settleAll();
    assert.notEqual(dial.last().value.value, start, "the first agent's name scrolled");
    dials.rotate("d", 1);
    await dial.settleAll();
    assert.deepEqual(
      [dial.last().value.value, dial.last().counter],
      [start, "2/2"],
      "the other agent starts at the beginning",
    );
    clock.advance(FOOTER_SCROLL.pauseMs - 1);
    await dial.settleAll();
    assert.equal(dial.last().value.value, start, "with the full start pause");
  });

  it("answers none to a press after dispose", async () => {
    const { dials } = setup();
    const dial = new GatedDial("d");
    dials.appear(dial);
    await dial.settleAll();
    dials.dispose();
    assert.deepEqual(dials.press("d"), { kind: "none" });
  });
});
