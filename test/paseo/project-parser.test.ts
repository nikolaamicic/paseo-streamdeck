import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseProject,
  parseProjectList,
  parseProjectUpdate,
} from "../../src/paseo/project-parser.ts";
import { SERVER_ID } from "../support/fixtures.ts";

/** Project payloads (P1, protocol 0.15.4) with synthetic names only. */

const descriptor = (projectId: string, projectDisplayName: string) => ({
  projectId,
  projectDisplayName,
  projectRootPath: "/tmp/synthetic",
  projectKind: "git",
  projectKey: "key",
});

describe("project parser", () => {
  it("keeps the ID and the resolved name only, with the host's server ID", () => {
    assert.deepEqual(parseProject(SERVER_ID, descriptor("p-alpha", "Project Alpha")), {
      address: { serverId: SERVER_ID, projectId: "p-alpha" },
      name: "Project Alpha",
    });
    assert.doesNotMatch(JSON.stringify(parseProject(SERVER_ID, descriptor("p", "x"))), /tmp/);
    for (const bad of [null, {}, descriptor("", "x"), { projectId: "p", projectDisplayName: 1 }]) {
      assert.equal(parseProject(SERVER_ID, bad), null);
    }
  });

  it("reads a list with its sync position, counts skipped entries, and reports no position", () => {
    const list = parseProjectList(SERVER_ID, {
      requestId: "r",
      projects: [
        descriptor("p-alpha", "Project Alpha"),
        { bad: true },
        descriptor("p-gamma", "Project Gamma"),
      ],
      sync: { generation: "g1", headSeq: 7, mode: "snapshot", removals: [] },
    });
    assert.ok(list);
    assert.deepEqual(
      list.projects.map((project) => project.address.projectId),
      ["p-alpha", "p-gamma"],
    );
    assert.deepEqual([list.skipped, list.sync], [1, { generation: "g1", headSeq: 7 }]);
    assert.equal(parseProjectList(SERVER_ID, { projects: [] })?.sync, null);
    assert.equal(
      parseProjectList(SERVER_ID, { projects: [], sync: { generation: "g1" } })?.sync,
      null,
    );
    assert.equal(parseProjectList(SERVER_ID, { projects: "x" }), null);
  });

  it("reads upserts and removes with their position, or without one", () => {
    assert.deepEqual(
      parseProjectUpdate(SERVER_ID, {
        kind: "upsert",
        project: descriptor("p-alpha", "Renamed Alpha"),
        generation: "g1",
        seq: 8,
      }),
      {
        kind: "upsert",
        project: { address: { serverId: SERVER_ID, projectId: "p-alpha" }, name: "Renamed Alpha" },
        position: { generation: "g1", headSeq: 8 },
      },
    );
    assert.deepEqual(parseProjectUpdate(SERVER_ID, { kind: "remove", projectId: "p-beta" }), {
      kind: "remove",
      projectId: "p-beta",
      position: null,
    });
    for (const bad of [null, { kind: "upsert" }, { kind: "remove" }, { kind: "other" }]) {
      assert.equal(parseProjectUpdate(SERVER_ID, bad), null);
    }
  });
});

describe("parseProjectList: the snapshot mode (C6 finding)", () => {
  it("reads a snapshot's position and never takes a changes answer for the whole list", () => {
    const snapshot = parseProjectList(SERVER_ID, {
      projects: [],
      sync: { generation: "g1", headSeq: 3, mode: "snapshot", reason: "no_cursor", removals: [] },
    });
    assert.deepEqual(snapshot?.sync, { generation: "g1", headSeq: 3 });
    assert.equal(
      parseProjectList(SERVER_ID, {
        projects: [],
        sync: { generation: "g1", headSeq: 3, mode: "changes", removals: [] },
      }),
      null,
    );
  });
});
