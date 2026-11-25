import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StripText } from "../../src/navigation/navigation.ts";
import { WorkspaceDials, type DialHandle } from "../../src/spike/workspace-dial.ts";
import type { InspectorFacts, InspectorView } from "../../src/spike/workspace-inspector.ts";
import {
  START_IN_ALL,
  startInSettings,
  type StartInSettings,
} from "../../src/workspaces/start-in-settings.ts";
import { WorkspaceDialContexts } from "../../src/workspaces/workspace-dial-contexts.ts";
import { projectKey } from "../../src/workspaces/project-model.ts";
import { deferred, flush, ManualScheduler } from "../support/fake-client.ts";
import { makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

/*
 * The Project dial's controller (P2, adapted from the workspace dial: Start
 * in names a project; Alpha and Beta are the host's projects).
 */
const at = (projectId: string, serverId = SERVER_ID) => ({ serverId, projectId });
const saved = (projectId: string) => ({ kind: "project", address: at(projectId) });
const ALPHA = { address: at("p-alpha"), name: "Alpha" };
const BETA = { address: at("p-beta"), name: "Beta" };
const shown = (value: string): StripText => ({
  label: { value: "Project", color: "#a6a6ae" },
  value,
  hint: "",
});

class FakeDial implements DialHandle {
  readonly stored: StartInSettings[] = [];
  readonly feedback: StripText[] = [];
  saveGate: Promise<void> | null = null;
  saveError: Error | null = null;

  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  async setSettings(settings: StartInSettings): Promise<void> {
    if (this.saveGate) await this.saveGate;
    if (this.saveError) throw this.saveError;
    this.stored.push(settings);
  }

  setFeedback(feedback: StripText): Promise<void> {
    this.feedback.push(feedback);
    return Promise.resolve();
  }
}

function setup(overrides: Partial<InspectorFacts> = {}) {
  let facts: InspectorFacts = {
    connection: "ok",
    failure: null,
    ready: true,
    stale: false,
    link: "connected",
    serverId: SERVER_ID,
    workspaces: [
      makeWorkspace({ workspaceId: "w1", projectId: "p-alpha" }),
      makeWorkspace({ workspaceId: "w2", projectId: "p-beta" }),
    ],
    truncated: false,
    projects: { status: "ready", projects: [ALPHA, BETA], current: true },
    ...overrides,
  };
  const contexts = new WorkspaceDialContexts();
  const retries: string[] = [];
  let retryResult = () => true;
  const sent: InspectorView[] = [];
  const logs: string[] = [];
  const dials = new WorkspaceDials({
    contexts,
    timers: new ManualScheduler(),
    facts: () => facts,
    // A stand-in for the navigation's strip: the stored Start in by name.
    strip: (id) => {
      const startIn = contexts.startIn(id) ?? START_IN_ALL;
      const record =
        startIn.kind === "project"
          ? facts.projects.projects.find(
              (project) => project.address.projectId === startIn.address.projectId,
            )
          : undefined;
      const value = !facts.ready
        ? "Loading…"
        : startIn.kind === "all"
          ? "All projects"
          : (record?.name ?? "Removed");
      return {
        text: { label: { value: "Project", color: "#a6a6ae" }, value, hint: "" },
        preview: null,
      };
    },
    retryProjects: () => {
      retries.push("retry");
      return retryResult();
    },
    sendToInspector: (_context, view) => {
      sent.push(view);
      return Promise.resolve();
    },
    log: (code) => logs.push(code),
  });
  return {
    contexts,
    sent,
    logs,
    dials,
    retries,
    setRetryResult: (result: boolean) => {
      retryResult = () => result;
    },
    setFacts: (next: Partial<InspectorFacts>) => {
      facts = { ...facts, ...next };
    },
  };
}

const lastFor = (sent: InspectorView[], context: string) =>
  sent.filter((view) => view.context === context).at(-1);

describe("WorkspaceDials", () => {
  it("shows the stored Start in on the dial and reports unusable settings without writing", async () => {
    const { dials, logs } = setup();
    const empty = new FakeDial("a");
    dials.appear(empty, {});
    const saved = new FakeDial("b");
    dials.appear(saved, startInSettings(at("p-beta")));
    const broken = new FakeDial("c");
    dials.appear(broken, { version: 7 });
    await flush();
    assert.deepEqual(empty.feedback.at(-1), shown("All projects"));
    assert.deepEqual(saved.feedback.at(-1), shown("Beta"));
    assert.deepEqual(broken.feedback.at(-1), shown("All projects"));
    assert.ok(logs.includes("start_in_settings_unsupported_version"));
    assert.equal(broken.stored.length, 0, "unusable settings are never rewritten automatically");
  });

  it("sends a valid choice, updates the W5 context at once and reports it as sent", async () => {
    const { dials, contexts, sent } = setup();
    const dial = new FakeDial("a");
    dials.appear(dial, {});
    await dials.request("a", { type: "choose", value: projectKey(at("p-alpha")) });
    await flush();
    assert.deepEqual(dial.stored, [startInSettings(at("p-alpha"))]);
    assert.deepEqual(contexts.startIn("a"), saved("p-alpha"));
    const view = lastFor(sent, "a");
    assert.ok(view);
    assert.equal(view.message, "Setting sent to Stream Deck.");
    assert.equal(view.selected, projectKey(at("p-alpha")));
    assert.deepEqual(dial.feedback.at(-1), shown("Alpha"));
  });

  it("logs fixed phase codes for each request, without values", async () => {
    const { dials, logs } = setup();
    dials.appear(new FakeDial("a"), {});
    await dials.inspectorShown("a");
    await dials.request("a", { type: "refresh" });
    await dials.request("a", { type: "choose", value: projectKey(at("p-alpha")) });
    assert.deepEqual(logs, [
      "inspector_shown",
      "inspector_refresh_received",
      "inspector_choose_received",
      "start_in_sent",
    ]);
  });

  it("refuses choices while offline or stale and for workspaces not on this host, without writing", async () => {
    for (const [facts, value, message] of [
      [
        { link: "reconnecting" as const },
        "all",
        "Not saved: the project list is not current. Try again when it is.",
      ],
      [{ stale: true }, "all", "Not saved: the project list is not current. Try again when it is."],
      [{}, projectKey(at("p-alpha", "srv_Other")), "Not saved: that project is no longer listed."],
      [{}, projectKey(at("gone")), "Not saved: that project is no longer listed."],
    ] as const) {
      const { dials, contexts, sent } = setup(facts);
      const dial = new FakeDial("a");
      dials.appear(dial, startInSettings(at("p-beta")));
      await dials.request("a", { type: "choose", value });
      assert.equal(dial.stored.length, 0, message);
      assert.deepEqual(contexts.startIn("a"), saved("p-beta"), "the stored Start in is kept");
      assert.equal(lastFor(sent, "a")?.message, message);
    }
  });

  it("reports a failed send and keeps the previous Start in", async () => {
    const { dials, contexts, sent, logs } = setup();
    const dial = new FakeDial("a");
    dials.appear(dial, startInSettings(at("p-beta")));
    dial.saveError = new Error("raw failure");
    await dials.request("a", { type: "choose", value: "all" });
    assert.deepEqual(contexts.startIn("a"), saved("p-beta"));
    assert.equal(lastFor(sent, "a")?.message, "Could not send the setting to Stream Deck.");
    assert.ok(logs.includes("start_in_send_failed"));
    assert.doesNotMatch(JSON.stringify([sent, logs]), /raw failure/);
  });

  it("ignores messages for unknown or hidden contexts and malformed messages", async () => {
    const { dials, contexts, sent, logs } = setup();
    await dials.request("never", { type: "choose", value: "all" });
    const dial = new FakeDial("a");
    dials.appear(dial, {});
    dials.disappear("a");
    await dials.request("a", { type: "choose", value: "all" });
    dials.settingsReceived("a", startInSettings(at("p-alpha")));
    assert.equal(contexts.choice("a"), undefined, "a hidden dial is not revived");
    assert.equal(dial.stored.length, 0);
    assert.equal(logs.filter((code) => code === "inspector_unknown_context").length, 2);

    const visible = new FakeDial("b");
    dials.appear(visible, {});
    const before = sent.length;
    for (const payload of [null, { type: "choose" }, { type: "erase" }, "x"]) {
      await dials.request("b", payload);
    }
    assert.equal(sent.length, before);
    assert.equal(logs.filter((code) => code === "inspector_bad_message").length, 4);
  });

  it("runs one context's saves in order and finishes with the last choice", async () => {
    const { dials, contexts } = setup();
    const dial = new FakeDial("a");
    dials.appear(dial, {});
    const gate = deferred<undefined>();
    dial.saveGate = gate.promise;
    const first = dials.request("a", { type: "choose", value: projectKey(at("p-alpha")) });
    const second = dials.request("a", { type: "choose", value: projectKey(at("p-beta")) });
    gate.resolve(undefined);
    await Promise.all([first, second]);
    assert.deepEqual(dial.stored, [startInSettings(at("p-alpha")), startInSettings(at("p-beta"))]);
    assert.deepEqual(contexts.startIn("a"), saved("p-beta"));
  });

  it("does not revive a dial that disappeared while its save was in flight", async () => {
    const { dials, contexts } = setup();
    const dial = new FakeDial("a");
    dials.appear(dial, {});
    const gate = deferred<undefined>();
    dial.saveGate = gate.promise;
    const saving = dials.request("a", { type: "choose", value: "all" });
    dials.disappear("a");
    gate.resolve(undefined);
    await saving;
    assert.equal(contexts.choice("a"), undefined);
  });

  it("keeps contexts apart and resends the view when an inspector asks again", async () => {
    const { dials, contexts, sent } = setup();
    dials.appear(new FakeDial("a"), startInSettings(at("p-alpha")));
    dials.appear(new FakeDial("b"), startInSettings(at("p-beta")));
    await dials.request("a", { type: "choose", value: "all" });
    assert.equal(contexts.startIn("a"), START_IN_ALL);
    assert.deepEqual(contexts.startIn("b"), saved("p-beta"), "no shared state between dials");

    await dials.request("b", { type: "refresh" });
    const count = sent.filter((view) => view.context === "b").length;
    await dials.request("b", { type: "refresh" });
    assert.equal(
      sent.filter((view) => view.context === "b").length,
      count + 1,
      "reopened inspector",
    );
  });

  it("drops a queued write when its dial disappears before the write starts", async () => {
    const { dials, logs } = setup();
    const dial = new FakeDial("a");
    dials.appear(dial, {});
    const pending = dials.request("a", { type: "choose", value: "all" });
    dials.disappear("a");
    await pending;
    assert.equal(dial.stored.length, 0, "nothing is sent for a hidden dial");
    assert.ok(logs.includes("inspector_choice_dropped"));
    assert.equal(dials.pendingWrites, 0);
  });

  it("never lets an old instance's writes reach or report to a reappeared dial", async () => {
    const { dials, contexts, sent } = setup();
    const old = new FakeDial("a");
    dials.appear(old, startInSettings(at("p-beta")));
    const gate = deferred<undefined>();
    old.saveGate = gate.promise;
    const inFlight = dials.request("a", { type: "choose", value: projectKey(at("p-alpha")) });
    const queued = dials.request("a", { type: "choose", value: "all" });
    await flush();
    dials.disappear("a");
    const fresh = new FakeDial("a");
    dials.appear(fresh, startInSettings(at("p-beta")));
    await flush();
    const viewsBefore = sent.length;
    gate.resolve(undefined);
    await Promise.all([inFlight, queued]);
    await flush();
    assert.deepEqual(old.stored, [startInSettings(at("p-alpha"))], "only the write already sent");
    assert.equal(fresh.stored.length, 0, "the queued write does not hit the new instance");
    assert.deepEqual(
      contexts.startIn("a"),
      saved("p-beta"),
      "the new instance keeps its own settings",
    );
    assert.equal(sent.length, viewsBefore, "no success shown to the new instance");
    assert.equal(dials.pendingWrites, 0, "the write queue is cleaned up");
  });

  it("does not show an old instance's failed send to a reappeared dial", async () => {
    const { dials, sent, logs } = setup();
    const old = new FakeDial("a");
    dials.appear(old, {});
    const gate = deferred<undefined>();
    old.saveGate = gate.promise;
    old.saveError = new Error("raw failure");
    const inFlight = dials.request("a", { type: "choose", value: "all" });
    await flush();
    dials.disappear("a");
    dials.appear(new FakeDial("a"), {});
    await flush();
    const viewsBefore = sent.length;
    gate.resolve(undefined);
    await inFlight;
    assert.equal(sent.length, viewsBefore);
    assert.ok(logs.includes("start_in_send_failed"));
  });

  it("drops dials and queued writes on dispose and ignores later events", async () => {
    const { dials, contexts, sent } = setup();
    const dial = new FakeDial("a");
    dials.appear(dial, {});
    const gate = deferred<undefined>();
    dial.saveGate = gate.promise;
    const inFlight = dials.request("a", { type: "choose", value: projectKey(at("p-alpha")) });
    const queued = dials.request("a", { type: "choose", value: projectKey(at("p-beta")) });
    await flush();
    dials.dispose();
    const viewsBefore = sent.length;
    gate.resolve(undefined);
    await Promise.all([inFlight, queued]);
    dials.appear(new FakeDial("b"), {});
    dials.refresh();
    await flush();
    assert.deepEqual(dial.stored, [startInSettings(at("p-alpha"))], "the queued write is dropped");
    assert.equal(contexts.choice("a"), undefined);
    assert.equal(contexts.choice("b"), undefined, "no dial appears after dispose");
    assert.equal(sent.length, viewsBefore);
    assert.equal(dials.pendingWrites, 0);
  });

  it("sends the view when an inspector is shown, only for a visible dial", async () => {
    const { dials, sent } = setup();
    await dials.inspectorShown("a");
    assert.equal(sent.length, 0, "no dial, no view");
    dials.appear(new FakeDial("a"), {});
    await flush();
    const before = sent.length;
    await dials.inspectorShown("a");
    assert.equal(sent.length, before + 1, "sent again although unchanged");
    assert.equal(sent.at(-1)?.context, "a");
  });

  it("updates dials and inspectors on feed changes only when something changed", async () => {
    const { dials, sent, setFacts } = setup({ ready: false });
    const dial = new FakeDial("a");
    dials.appear(dial, startInSettings(at("p-alpha")));
    await flush();
    assert.deepEqual(dial.feedback.at(-1), shown("Loading…"));
    const views = sent.length;
    dials.refresh();
    await flush();
    assert.equal(sent.length, views, "nothing changed, nothing sent");
    setFacts({ ready: true });
    dials.refresh();
    await flush();
    assert.deepEqual(dial.feedback.at(-1), shown("Alpha"));
    assert.equal(lastFor(sent, "a")?.status, "Choose the project this dial starts in.");
  });

  it("Retry projects asks the feed once per press, writes nothing and answers the inspector", async () => {
    const { dials, retries, sent, logs, setRetryResult } = setup({
      projects: { status: "unavailable", projects: [], current: false },
    });
    const dial = new FakeDial("a");
    dials.appear(dial, {});
    await dials.request("a", { type: "retry_projects" });
    assert.deepEqual(retries, ["retry"]);
    assert.equal(lastFor(sent, "a")?.message, "Reading the project list again…");
    assert.equal(lastFor(sent, "a")?.canRetry, true, "the view offers Retry for this state");
    assert.ok(logs.includes("projects_retry_started"));
    setRetryResult(false);
    await dials.request("a", { type: "retry_projects" });
    assert.equal(lastFor(sent, "a")?.message, "Retry is not available right now.");
    assert.ok(logs.includes("projects_retry_unavailable"));
    assert.equal(dial.stored.length, 0, "Retry never writes settings");
    await dials.request("unknown", { type: "retry_projects" });
    assert.equal(retries.length, 2, "an unknown context asks nothing");
  });

  it("an explicit choice writes version 2 and keeps unknown settings fields", async () => {
    const { dials, contexts } = setup();
    const dial = new FakeDial("a");
    const legacy = {
      version: 1,
      startIn: { serverId: SERVER_ID, workspaceId: "w1" },
      note: "other writer",
    };
    dials.appear(dial, legacy);
    assert.equal(dial.stored.length, 0, "a version 1 Start in is never rewritten by itself");
    await dials.request("a", { type: "choose", value: projectKey(at("p-beta")) });
    assert.deepEqual(dial.stored, [
      { note: "other writer", version: 2, startIn: { serverId: SERVER_ID, projectId: "p-beta" } },
    ]);
    assert.deepEqual(contexts.startIn("a"), saved("p-beta"));
  });

  it("a Start in choice keeps an own __proto__ field as data, without changing any prototype", async () => {
    const { dials } = setup();
    const dial = new FakeDial("a");
    const previous: unknown = JSON.parse(
      '{"version":1,"startIn":null,"__proto__":{"keep":true},"extra":42}',
    );
    dials.appear(dial, previous);
    await dials.request("a", { type: "choose", value: projectKey(at("p-beta")) });
    const [stored] = dial.stored;
    assert.ok(stored);
    assert.equal(Object.hasOwn(stored, "__proto__"), true, "kept as an own field");
    assert.equal(Object.getPrototypeOf(stored), Object.prototype, "the prototype is unchanged");
    assert.deepEqual(
      JSON.parse(JSON.stringify(stored)),
      JSON.parse(
        '{"__proto__":{"keep":true},"extra":42,"version":2,"startIn":{"serverId":"' +
          SERVER_ID +
          '","projectId":"p-beta"}}',
      ),
    );
    assert.equal(Reflect.get(Object.prototype, "keep"), undefined, "no global prototype change");
  });
});
