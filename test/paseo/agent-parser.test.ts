import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentDirectory } from "../../src/agents/agent-directory.ts";
import { parseAgentUpdate, parseDirectoryEntry } from "../../src/paseo/agent-parser.ts";
import { agentPayload, entry, projectPayload, SERVER_ID } from "../support/paseo-payloads.ts";

describe("parseDirectoryEntry", () => {
  it("maps an entry and takes the server ID from the host, not the payload", () => {
    const parsed = parseDirectoryEntry(
      SERVER_ID,
      entry({ id: "agent-7", provider: "codex", serverId: "srv_FromPayload" }),
    );
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.address, { serverId: SERVER_ID, agentId: "agent-7" });
    assert.equal(parsed.value.provider, "codex");
    assert.deepEqual(parsed.value.project, { key: "project-key-1", name: "Test project" });
  });

  it("keeps the workspace placement and treats unusable values as no placement", () => {
    const placed = parseDirectoryEntry(SERVER_ID, entry({ workspaceId: "workspace-9" }));
    assert.ok(placed.ok);
    assert.equal(placed.value.workspaceId, "workspace-9");
    const withoutPlacement = agentPayload();
    delete withoutPlacement["workspaceId"];
    const cases: unknown[] = [
      withoutPlacement,
      ...["", "  ", null, 7, {}, "\uD800", "ws-\uDC00"].map((workspaceId) =>
        agentPayload({ workspaceId }),
      ),
    ];
    for (const agent of cases) {
      const parsed = parseDirectoryEntry(SERVER_ID, { agent, project: projectPayload() });
      assert.ok(parsed.ok, "an agent without a usable placement is still listed");
      assert.equal(parsed.value.workspaceId, null);
    }
  });

  it("keeps an unknown lifecycle status raw and normalizes it to unknown", () => {
    const parsed = parseDirectoryEntry(SERVER_ID, entry({ status: "suspended" }));
    assert.ok(parsed.ok);
    assert.equal(parsed.value.rawStatus, "suspended");
    assert.equal(parsed.value.status, "unknown");
  });

  it("drops an unknown attention reason instead of guessing", () => {
    const parsed = parseDirectoryEntry(
      SERVER_ID,
      entry({ requiresAttention: true, attentionReason: "reviewed" }),
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.value.requiresAttention, true);
    assert.equal(parsed.value.attentionReason, null);
  });

  it("keeps only permission kinds; request inputs and other content are never retained", () => {
    const parsed = parseDirectoryEntry(
      SERVER_ID,
      entry({
        pendingPermissions: [
          {
            id: "p1",
            kind: "tool",
            name: "Bash",
            description: "synthetic-description",
            input: { command: "synthetic-command --flag" },
          },
          { id: "p2", kind: "future-kind", name: "X" },
        ],
        lastError: "synthetic-error-text",
        timeline: [{ text: "synthetic-conversation" }],
      }),
    );
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.pendingPermissionKinds, ["tool", "other"]);
    const serialized = JSON.stringify(parsed.value);
    for (const leaked of [
      "synthetic-command",
      "synthetic-description",
      "synthetic-error-text",
      "synthetic-conversation",
      "/tmp/test-workspace",
    ]) {
      assert.equal(serialized.includes(leaked), false, `${leaked} must not be retained`);
    }
  });

  it("records only whether the daemon reported a failed last turn", () => {
    const failed = parseDirectoryEntry(SERVER_ID, entry({ lastError: "synthetic-error-text" }));
    assert.ok(failed.ok);
    assert.equal(failed.value.lastTurnFailed, true);
    for (const lastError of [undefined, "", "   ", null, 7]) {
      const parsed = parseDirectoryEntry(SERVER_ID, entry({ lastError }));
      assert.ok(parsed.ok);
      assert.equal(parsed.value.lastTurnFailed, false, String(lastError));
    }
  });

  it("reports a missing or malformed project as unknown rather than inventing one", () => {
    for (const project of [null, { projectKey: "k" }, { projectKey: "", projectName: "n" }]) {
      const parsed = parseDirectoryEntry(SERVER_ID, entry({}, project));
      assert.ok(parsed.ok);
      assert.equal(parsed.value.project, null);
    }
  });

  it("detects delegated agents from the Paseo parent label", () => {
    const parsed = parseDirectoryEntry(
      SERVER_ID,
      entry({ labels: { "paseo.parent-agent-id": "parent-1" } }),
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.value.parentAgentId, "parent-1");
  });

  it("normalizes an empty title to none", () => {
    const parsed = parseDirectoryEntry(SERVER_ID, entry({ title: "   " }));
    assert.ok(parsed.ok);
    assert.equal(parsed.value.title, null);
  });

  it("reports validation failures as stable codes without payload values", () => {
    const parsed = parseDirectoryEntry(
      SERVER_ID,
      entry({ id: "SENSITIVE-SENTINEL-4d1e", provider: null }),
    );
    assert.deepEqual(parsed, { ok: false, error: "missing_provider" });
  });

  const invalid: [string, unknown][] = [
    ["a non-object entry", "nope"],
    ["an entry without agent", { project: projectPayload() }],
    ["an agent without id", { agent: agentPayload({ id: "" }), project: null }],
    ["an agent with a numeric status", { agent: agentPayload({ status: 3 }), project: null }],
    ["an agent without provider", { agent: agentPayload({ provider: null }), project: null }],
    [
      "an agent without permission list",
      { agent: agentPayload({ pendingPermissions: "x" }), project: null },
    ],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => {
      assert.equal(parseDirectoryEntry(SERVER_ID, value).ok, false);
    });
  }
});

describe("parseAgentUpdate", () => {
  it("parses an upsert that carries a project", () => {
    const parsed = parseAgentUpdate(SERVER_ID, {
      kind: "upsert",
      agent: agentPayload({ status: "running" }),
      project: projectPayload(),
    });
    assert.ok(parsed.ok);
    const update = parsed.value;
    assert.ok(update.kind === "upsert");
    assert.equal(update.record.status, "running");
    assert.equal(update.projectProvided, true);
  });

  it("distinguishes an omitted project (keep known) from an explicit null (none)", () => {
    const omitted = parseAgentUpdate(SERVER_ID, { kind: "upsert", agent: agentPayload() });
    const explicitNull = parseAgentUpdate(SERVER_ID, {
      kind: "upsert",
      agent: agentPayload(),
      project: null,
    });
    assert.ok(omitted.ok && omitted.value.kind === "upsert");
    assert.ok(explicitNull.ok && explicitNull.value.kind === "upsert");
    assert.equal(omitted.value.projectProvided, false);
    assert.equal(explicitNull.value.projectProvided, true);
    assert.equal(explicitNull.value.record.project, null);
  });

  it("rejects agent IDs with unpaired surrogates and keeps valid astral IDs usable", () => {
    for (const id of ["\uD800", "agent-\uDC00"]) {
      assert.deepEqual(parseDirectoryEntry(SERVER_ID, entry({ id })), {
        ok: false,
        error: "invalid_id",
      });
      assert.deepEqual(parseAgentUpdate(SERVER_ID, { kind: "remove", agentId: id }), {
        ok: false,
        error: "invalid_id",
      });
    }
    const parsed = parseDirectoryEntry(SERVER_ID, entry({ id: "agent-\uD83D\uDE00" }));
    assert.ok(parsed.ok);
    const directory = new AgentDirectory();
    assert.equal(directory.upsert(parsed.value)?.kind, "added");
    assert.equal(directory.remove(parsed.value.address)?.kind, "removed");
  });

  it("parses a remove", () => {
    assert.deepEqual(parseAgentUpdate(SERVER_ID, { kind: "remove", agentId: "agent-1" }), {
      ok: true,
      value: { kind: "remove", agentId: "agent-1" },
    });
  });

  it("rejects unknown kinds and malformed payloads", () => {
    assert.equal(parseAgentUpdate(SERVER_ID, { kind: "rename" }).ok, false);
    assert.equal(parseAgentUpdate(SERVER_ID, { kind: "remove" }).ok, false);
    assert.equal(parseAgentUpdate(SERVER_ID, { kind: "upsert", agent: {} }).ok, false);
    assert.equal(parseAgentUpdate(SERVER_ID, null).ok, false);
  });
});
