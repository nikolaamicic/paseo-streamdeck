import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readStartIn,
  START_IN_ALL,
  START_IN_SETTINGS_VERSION,
  startInSettings,
} from "../../src/workspaces/start-in-settings.ts";
import { SERVER_ID } from "../support/fixtures.ts";

/**
 * Start in settings (P2): version 2 stores a project and is the only one
 * written; version 1 (a workspace) is read only. Intended change from W6:
 * version 2 was "unsupported" before and is now the current version.
 */

const project = { serverId: SERVER_ID, projectId: "p-alpha" };
const workspace = { serverId: SERVER_ID, workspaceId: "w1" };
const v2 = (startIn: unknown, extra: Record<string, unknown> = {}) => ({
  version: 2,
  startIn,
  ...extra,
});
const v1 = (startIn: unknown) => ({ version: 1, startIn });

describe("readStartIn", () => {
  it("reads a version 2 project and ignores unknown extra fields", () => {
    const read = readStartIn(v2(project, { note: "kept by Stream Deck, ignored here" }));
    assert.deepEqual(read, { startIn: { kind: "project", address: project }, issue: null });
    assert.equal(Object.isFrozen(read.startIn), true);
  });

  it("reads a version 1 workspace as a legacy Start in, never as a project", () => {
    assert.deepEqual(readStartIn(v1(workspace)), {
      startIn: { kind: "legacy_workspace", address: workspace },
      issue: null,
    });
  });

  it("means All for empty settings, and for null in either version", () => {
    for (const settings of [{}, v1(null), v2(null), { version: 2 }]) {
      assert.deepEqual(readStartIn(settings), { startIn: START_IN_ALL, issue: null });
    }
  });

  it("falls back to All with a stable code for unusable settings", () => {
    const cases: [unknown, string][] = [
      [null, "settings_not_object"],
      [[project], "settings_not_object"],
      [{ startIn: project }, "unsupported_version"],
      [{ version: 3, startIn: project }, "unsupported_version"],
      [v2("p1"), "invalid_start_in"],
      [v2(workspace), "invalid_start_in"],
      [v1(project), "invalid_start_in"],
      [v2({ serverId: SERVER_ID, projectId: "  " }), "invalid_start_in"],
      [v2({ serverId: SERVER_ID, projectId: "p\uD800" }), "invalid_start_in"],
      [v2({ serverId: SERVER_ID, projectId: "p".repeat(257) }), "invalid_start_in"],
    ];
    for (const [settings, issue] of cases) {
      assert.deepEqual(
        readStartIn(settings),
        { startIn: START_IN_ALL, issue },
        JSON.stringify(settings),
      );
    }
  });
});

describe("startInSettings", () => {
  it("writes version 2 that readStartIn reads back, with IDs only", () => {
    assert.equal(START_IN_SETTINGS_VERSION, 2);
    for (const [address, expected] of [
      [project, { kind: "project", address: project }],
      [null, START_IN_ALL],
    ] as const) {
      const roundTrip: unknown = JSON.parse(JSON.stringify(startInSettings(address)));
      assert.deepEqual(readStartIn(roundTrip), { startIn: expected, issue: null });
    }
    assert.deepEqual(Object.keys(startInSettings(project).startIn ?? {}), [
      "serverId",
      "projectId",
    ]);
  });

  it("keeps unknown fields of the previous settings and replaces only version and startIn", () => {
    const previous = Object.freeze({
      version: 1,
      startIn: workspace,
      note: "other writer",
      nested: { list: [1, "two", null, true] },
    });
    assert.deepEqual(startInSettings(project, previous), {
      note: "other writer",
      nested: { list: [1, "two", null, true] },
      version: 2,
      startIn: project,
    });
    assert.deepEqual(previous.startIn, workspace, "the previous settings are not changed");
    assert.deepEqual(startInSettings(null, "not an object"), { version: 2, startIn: null });
  });
});
