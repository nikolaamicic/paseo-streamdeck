import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkspaceDescriptorPayloadSchema } from "@getpaseo/protocol/messages";
import { parseWorkspace, parseWorkspaceUpdate } from "../../src/paseo/workspace-parser.ts";
import { WorkspaceDirectory } from "../../src/workspaces/workspace-directory.ts";
import { WORKSPACE_STATUSES } from "../../src/workspaces/workspace-model.ts";
import { SERVER_ID, workspacePayload } from "../support/paseo-payloads.ts";

describe("workspace test payload", () => {
  it("is accepted by the pinned protocol schema, as are all known statuses", () => {
    assert.equal(WorkspaceDescriptorPayloadSchema.safeParse(workspacePayload()).success, true);
    for (const status of WORKSPACE_STATUSES) {
      const payload = workspacePayload({ status });
      assert.equal(WorkspaceDescriptorPayloadSchema.safeParse(payload).success, true, status);
    }
    const unknown = workspacePayload({ status: "paused" });
    assert.equal(WorkspaceDescriptorPayloadSchema.safeParse(unknown).success, false);
  });
});

describe("parseWorkspace", () => {
  it("keeps only the displayed fields and takes the server ID from the host", () => {
    const parsed = parseWorkspace(SERVER_ID, workspacePayload({ serverId: "srv_FromPayload" }));
    assert.deepEqual(parsed, {
      ok: true,
      value: {
        address: { serverId: SERVER_ID, workspaceId: "workspace-1" },
        name: "main",
        projectId: "project-1",
        projectName: "Test project",
        rawStatus: "done",
        status: "done",
        archiving: false,
      },
    });
    assert.doesNotMatch(JSON.stringify(parsed), /\/tmp\//);
  });

  it("keeps an unknown status raw and normalizes it to unknown", () => {
    const parsed = parseWorkspace(SERVER_ID, workspacePayload({ status: "paused" }));
    assert.ok(parsed.ok);
    assert.equal(parsed.value.rawStatus, "paused");
    assert.equal(parsed.value.status, "unknown");
  });

  it("marks archiving only for a non-empty archivingAt string", () => {
    const archiving = parseWorkspace(
      SERVER_ID,
      workspacePayload({ archivingAt: "2026-11-15T10:00:00.000Z" }),
    );
    assert.ok(archiving.ok);
    assert.equal(archiving.value.archiving, true);
    const omitted = workspacePayload();
    delete omitted["archivingAt"];
    const notArchiving: unknown[] = [
      omitted,
      ...[null, "", "  ", 5, {}, true].map((archivingAt) => workspacePayload({ archivingAt })),
    ];
    for (const payload of notArchiving) {
      const parsed = parseWorkspace(SERVER_ID, payload);
      assert.ok(parsed.ok);
      assert.equal(parsed.value.archiving, false);
    }
  });

  it("keeps a name as received, including an empty one the protocol allows", () => {
    const parsed = parseWorkspace(SERVER_ID, workspacePayload({ name: "" }));
    assert.ok(parsed.ok);
    assert.equal(parsed.value.name, "");
  });

  it("rejects invalid descriptors with a stable code and no payload values", () => {
    const cases: [unknown, string][] = [
      [null, "workspace_not_object"],
      [["workspace-1"], "workspace_not_object"],
      [workspacePayload({ id: undefined }), "missing_workspace_id"],
      [workspacePayload({ id: "  " }), "missing_workspace_id"],
      [workspacePayload({ id: 7 }), "missing_workspace_id"],
      [workspacePayload({ name: null }), "missing_workspace_name"],
      [workspacePayload({ projectDisplayName: 1 }), "missing_project_name"],
      // P1: the project link is a required, well-formed protocol field.
      [workspacePayload({ projectId: undefined }), "missing_project_id"],
      [workspacePayload({ projectId: "" }), "missing_project_id"],
      [workspacePayload({ status: undefined }), "missing_workspace_status"],
      [workspacePayload({ status: "" }), "missing_workspace_status"],
    ];
    for (const [payload, error] of cases) {
      assert.deepEqual(parseWorkspace(SERVER_ID, payload), { ok: false, error });
    }
  });
});

describe("workspace ID text", () => {
  const malformed = ["\uD800", "\uDC00", "ws-\uD800-x", "ws-\uDC00\uD800"];

  it("rejects IDs with unpaired surrogates in descriptors and removals, without the payload", () => {
    for (const id of malformed) {
      assert.deepEqual(parseWorkspace(SERVER_ID, workspacePayload({ id })), {
        ok: false,
        error: "invalid_workspace_id",
      });
      assert.deepEqual(
        parseWorkspaceUpdate(SERVER_ID, { kind: "upsert", workspace: workspacePayload({ id }) }),
        {
          ok: false,
          error: "invalid_workspace_id",
        },
      );
      assert.deepEqual(parseWorkspaceUpdate(SERVER_ID, { kind: "remove", id }), {
        ok: false,
        error: "invalid_workspace_id",
      });
    }
  });

  it("keeps a valid astral character and stores, finds and removes it", () => {
    const id = "ws-\uD83D\uDE00/main";
    const parsed = parseWorkspace(SERVER_ID, workspacePayload({ id }));
    assert.ok(parsed.ok);
    assert.equal(parsed.value.address.workspaceId, id);
    const directory = new WorkspaceDirectory();
    assert.equal(directory.upsert(parsed.value)?.kind, "added");
    const removal = parseWorkspaceUpdate(SERVER_ID, { kind: "remove", id });
    assert.ok(removal.ok && removal.value.kind === "remove");
    const address = { serverId: SERVER_ID, workspaceId: removal.value.workspaceId };
    assert.equal(directory.get(address)?.name, "main");
    assert.equal(directory.remove(address)?.kind, "removed");
  });
});

describe("parseWorkspaceUpdate", () => {
  it("parses an upsert and a remove", () => {
    const upsert = parseWorkspaceUpdate(SERVER_ID, {
      kind: "upsert",
      workspace: workspacePayload({ id: "workspace-2", name: "feature" }),
    });
    assert.ok(upsert.ok && upsert.value.kind === "upsert");
    assert.deepEqual(upsert.value.record.address, {
      serverId: SERVER_ID,
      workspaceId: "workspace-2",
    });
    assert.deepEqual(
      parseWorkspaceUpdate(SERVER_ID, { kind: "remove", id: "workspace-2", removedProjectId: "p" }),
      { ok: true, value: { kind: "remove", workspaceId: "workspace-2" } },
    );
  });

  it("rejects malformed updates with a stable code", () => {
    const cases: [unknown, string][] = [
      [null, "workspace_update_not_object"],
      [{ kind: "remove" }, "remove_without_workspace_id"],
      [{ kind: "remove", id: "" }, "remove_without_workspace_id"],
      [{ kind: "rename", id: "workspace-1" }, "unknown_workspace_update_kind"],
      [{ kind: "upsert", workspace: {} }, "missing_workspace_id"],
      [{ kind: "upsert" }, "workspace_not_object"],
    ];
    for (const [payload, error] of cases) {
      assert.deepEqual(parseWorkspaceUpdate(SERVER_ID, payload), { ok: false, error });
    }
  });
});
