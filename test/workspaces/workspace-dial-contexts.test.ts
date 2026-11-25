import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { START_IN_ALL, startInSettings } from "../../src/workspaces/start-in-settings.ts";
import { WorkspaceDialContexts } from "../../src/workspaces/workspace-dial-contexts.ts";
import {
  ALL_PROJECTS,
  choiceSourceOf,
  selectProject,
  type ProjectSelection,
} from "../../src/workspaces/project-selection.ts";
import { makeWorkspace, SERVER_ID } from "../support/fixtures.ts";

/**
 * Per-context Start in and choice of the Project dial. Adapted from the
 * workspace version (intended P2 semantics): Start in names a project.
 */
const at = (projectId: string) => ({ serverId: SERVER_ID, projectId });
const label = (selection: ProjectSelection | null | undefined): string =>
  selection === null || selection === undefined
    ? "none"
    : selection.kind === "all"
      ? "All"
      : selection.kind === "project"
        ? selection.address.projectId
        : `unresolved:${selection.reason}`;

function readySource() {
  return choiceSourceOf({
    ready: true,
    stale: false,
    serverId: SERVER_ID,
    workspaces: [
      makeWorkspace({ workspaceId: "w1", projectId: "p1" }),
      makeWorkspace({ workspaceId: "w2", projectId: "p2" }),
    ],
    truncated: false,
  });
}

describe("WorkspaceDialContexts", () => {
  it("keeps each action context's Start in and selection separate", () => {
    const contexts = new WorkspaceDialContexts();
    contexts.appear("profile-a-dial", startInSettings(at("p1")));
    contexts.appear("profile-b-dial", startInSettings(at("p2")));
    contexts.appear("profile-c-dial", {});
    assert.deepEqual(contexts.sync(readySource()).sort(), [
      "profile-a-dial",
      "profile-b-dial",
      "profile-c-dial",
    ]);
    assert.equal(label(contexts.choice("profile-a-dial")?.selection), "p1");
    assert.equal(label(contexts.choice("profile-b-dial")?.selection), "p2");
    assert.equal(label(contexts.choice("profile-c-dial")?.selection), "All");

    assert.equal(contexts.choice("profile-a-dial")?.choose(ALL_PROJECTS), true);
    assert.equal(label(contexts.choice("profile-b-dial")?.selection), "p2", "no shared state");
    assert.deepEqual(
      contexts.startIn("profile-a-dial"),
      { kind: "project", address: at("p1") },
      "a choice never writes",
    );
  });

  it("keeps the current choice when the same context appears again with the same settings", () => {
    const contexts = new WorkspaceDialContexts();
    contexts.appear("dial", startInSettings(at("p1")));
    contexts.sync(readySource());
    contexts.choice("dial")?.choose(selectProject(at("p2")));
    contexts.appear("dial", startInSettings(at("p1")));
    assert.equal(label(contexts.choice("dial")?.selection), "p2");
  });

  it("applies a changed Start in from the Property Inspector at once", () => {
    const contexts = new WorkspaceDialContexts();
    contexts.appear("dial", startInSettings(at("p1")));
    const source = readySource();
    contexts.sync(source);
    contexts.choice("dial")?.choose(ALL_PROJECTS);

    assert.equal(contexts.settingsChanged("dial", startInSettings(at("p1"))), null);
    assert.equal(label(contexts.choice("dial")?.selection), "All", "same value keeps the choice");

    contexts.settingsChanged("dial", startInSettings(at("p2")));
    assert.deepEqual(contexts.sync(source), ["dial"]);
    assert.equal(label(contexts.choice("dial")?.selection), "p2");
  });

  it("drops a context's state when it disappears", () => {
    const contexts = new WorkspaceDialContexts();
    contexts.appear("dial", startInSettings(at("p1")));
    contexts.disappear("dial");
    assert.equal(contexts.choice("dial"), undefined);
    assert.equal(contexts.startIn("dial"), undefined);
    assert.deepEqual(contexts.sync(readySource()), []);
  });

  it("brings back the confirmed choice when the same dial reappears with the same Start in", () => {
    const contexts = new WorkspaceDialContexts();
    contexts.appear("dial", startInSettings(at("p1")));
    contexts.sync(readySource());
    contexts.choice("dial")?.choose(ALL_PROJECTS);
    contexts.disappear("dial");
    assert.equal(contexts.choice("dial"), undefined, "hidden: no events, no state shown");
    contexts.appear("dial", startInSettings(at("p1")));
    assert.equal(label(contexts.choice("dial")?.selection), "All", "kept across hide and show");
    contexts.disappear("dial");
    contexts.appear("dial", startInSettings(at("p2")));
    contexts.sync(readySource());
    assert.equal(label(contexts.choice("dial")?.selection), "p2", "a new Start in starts over");
  });

  it("ignores a settings change for a context that disappeared or never appeared", () => {
    const contexts = new WorkspaceDialContexts();
    contexts.appear("dial", {});
    contexts.disappear("dial");
    assert.equal(contexts.settingsChanged("dial", {}), null);
    assert.equal(contexts.choice("dial"), undefined, "a late event does not revive it");
    assert.equal(
      contexts.settingsChanged("never", { version: 9 }),
      "unsupported_version",
      "the code is still reported for logging",
    );
    assert.equal(contexts.choice("never"), undefined, "an event before appear creates nothing");
    assert.deepEqual(contexts.sync(readySource()), []);

    contexts.appear("dial", startInSettings(at("p2")));
    assert.deepEqual(contexts.sync(readySource()), ["dial"]);
    assert.equal(
      label(contexts.choice("dial")?.selection),
      "p2",
      "the next appear uses its saved settings",
    );
  });

  it("uses All and reports a code for unusable settings, without throwing", () => {
    const contexts = new WorkspaceDialContexts();
    assert.equal(contexts.appear("dial", { version: 9, startIn: at("p1") }), "unsupported_version");
    assert.equal(contexts.startIn("dial"), START_IN_ALL);
    contexts.sync(readySource());
    assert.equal(label(contexts.choice("dial")?.selection), "All");
    assert.equal(contexts.settingsChanged("dial", "garbage"), "settings_not_object");
  });

  it("keeps the settings last received, unknown fields included, for the next write", () => {
    const contexts = new WorkspaceDialContexts();
    const stored = { ...startInSettings(at("p1")), note: "other writer" };
    contexts.appear("dial", stored);
    assert.equal(contexts.settings("dial"), stored);
    const legacy = { version: 1, startIn: { serverId: SERVER_ID, workspaceId: "w2" }, extra: 1 };
    contexts.settingsChanged("dial", legacy);
    assert.equal(contexts.settings("dial"), legacy);
    contexts.sync(readySource());
    assert.equal(
      label(contexts.choice("dial")?.selection),
      "p2",
      "version 1 resolves to its project",
    );
    contexts.disappear("dial");
    assert.equal(contexts.settings("dial"), undefined);
  });
});
