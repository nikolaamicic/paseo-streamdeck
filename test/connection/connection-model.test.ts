import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseConnection,
  interpretLegacyFile,
  MAX_DAEMON_URL_LENGTH,
  MAX_LEGACY_BYTES,
  normalizeDaemonUrl,
  readSavedConnection,
  type ConnectionChoice,
  type LegacyConnection,
  type LegacyFile,
  type SavedConnection,
} from "../../src/connection/connection-model.ts";

/**
 * The connection model (C2) and its address rules.
 * Pure functions only: nothing reads a real file, settings or daemon.
 */

const DEFAULT = "ws://127.0.0.1:6767/ws";
const TARGET = { serverId: "srv_TestServer01", agentId: "agent-1" };

describe("normalizeDaemonUrl: accepted addresses", () => {
  const cases: [string, string][] = [
    ["ws://127.0.0.1:6767/ws", "ws://127.0.0.1:6767/ws"],
    ["ws://localhost:6767/ws", "ws://localhost:6767/ws"],
    ["ws://[::1]:6767/ws", "ws://[::1]:6767/ws"],
    ["ws://127.0.0.1:1/ws", "ws://127.0.0.1:1/ws"],
    ["ws://127.0.0.1:65535/ws", "ws://127.0.0.1:65535/ws"],
    // WHATWG drops the default port of ws:, the canonical form keeps it.
    ["ws://localhost:80/ws", "ws://localhost:80/ws"],
    ["WS://LocalHost:6767/ws", "ws://localhost:6767/ws"],
  ];
  for (const [raw, canonical] of cases) {
    it(`${raw} → ${canonical}, and normalizing that changes nothing`, () => {
      assert.deepEqual(normalizeDaemonUrl(raw), { ok: true, daemonUrl: canonical });
      assert.deepEqual(normalizeDaemonUrl(canonical), { ok: true, daemonUrl: canonical });
    });
  }

  it("addresses differing only in letter case are equal once normalized", () => {
    const a = normalizeDaemonUrl("ws://LOCALHOST:6767/ws");
    const b = normalizeDaemonUrl("Ws://localhost:6767/ws");
    assert.ok(a.ok && b.ok);
    assert.equal(a.daemonUrl, b.daemonUrl);
  });

  it("an explicit :80 is accepted; the missing port it looks like after WHATWG is not", () => {
    assert.equal(normalizeDaemonUrl("ws://localhost:80/ws").ok, true);
    assert.equal(new URL("ws://localhost:80/ws").port, "", "what WHATWG would report");
    assert.deepEqual(normalizeDaemonUrl("ws://localhost/ws"), {
      ok: false,
      error: "invalid_format",
    });
  });
});

describe("normalizeDaemonUrl: rejected input", () => {
  const rejects = (raw: unknown, error: string) => {
    assert.deepEqual(normalizeDaemonUrl(raw), { ok: false, error });
  };

  it("not a string", () => {
    for (const raw of [undefined, null, 6767, {}, ["ws://127.0.0.1:6767/ws"]]) {
      rejects(raw, "not_string");
    }
  });

  it("empty, and longer than the limit before any parsing", () => {
    rejects("", "empty");
    const padded = `ws://localhost:6767/ws${"x".repeat(MAX_DAEMON_URL_LENGTH)}`;
    rejects(padded, "too_long");
  });

  it("blanks, control characters, non-ASCII, lone surrogates, backslash, percent", () => {
    for (const raw of [
      " ws://127.0.0.1:6767/ws",
      "ws://127.0.0.1:6767/ws ",
      "ws://127.0.0.1:6767/w s",
      "ws://127.0.0.1:6767/ws\n",
      "\tws://127.0.0.1:6767/ws",
      "ws://127.0.0.1:6767/ws\u0000",
      "ws://127.0.0.1:6767/ws\u007f",
      "ws://127.0.0.1:6767/ws\u00a0",
      "ws://127.0.0.1:6767/ws\ud800",
      "ｗs://127.0.0.1:6767/ws",
      "ws://localhost:6767\\ws",
      "ws:\\\\localhost:6767/ws",
      "ws://localhost:6767/%77s",
      "ws://%6cocalhost:6767/ws",
    ]) {
      rejects(raw, "forbidden_character");
    }
  });

  it("other schemes, hosts, host aliases, credentials, paths, query and fragment", () => {
    for (const raw of [
      "wss://127.0.0.1:6767/ws",
      "http://127.0.0.1:6767/ws",
      "ws:127.0.0.1:6767/ws",
      "ws://127.1:6767/ws",
      "ws://2130706433:6767/ws",
      "ws://0x7f.0.0.1:6767/ws",
      "ws://0177.0.0.1:6767/ws",
      "ws://127.0.0.2:6767/ws",
      "ws://0.0.0.0:6767/ws",
      "ws://[::ffff:127.0.0.1]:6767/ws",
      "ws://[0:0:0:0:0:0:0:1]:6767/ws",
      "ws://localhost.:6767/ws",
      "ws://localhost.example.com:6767/ws",
      "ws://example.com:6767/ws",
      "ws://user@localhost:6767/ws",
      "ws://user:pass@localhost:6767/ws",
      "ws://localhost:6767@example.com:6767/ws",
      "ws://localhost/ws",
      "ws://localhost:/ws",
      "ws://localhost:0/ws",
      "ws://localhost:06767/ws",
      "ws://localhost:6767",
      "ws://localhost:6767/",
      "ws://localhost:6767/WS",
      "ws://localhost:6767/ws/",
      "ws://localhost:6767/./ws",
      "ws://localhost:6767/x/../ws",
      "ws://localhost:6767/ws/.",
      "ws://localhost:6767/ws?x=1",
      "ws://localhost:6767/ws?",
      "ws://localhost:6767/ws#x",
    ]) {
      rejects(raw, "invalid_format");
    }
  });

  it("ports above 65535", () => {
    rejects("ws://localhost:65536/ws", "port_out_of_range");
    rejects("ws://localhost:99999/ws", "port_out_of_range");
  });

  it("an error result never contains the input", () => {
    const secret = "ws://user:hunter2@localhost:6767/ws";
    assert.equal(JSON.stringify(normalizeDaemonUrl(secret)).includes("hunter2"), false);
  });
});

describe("readSavedConnection", () => {
  const loaded = (settings: unknown) => readSavedConnection({ kind: "loaded", settings });

  it("an unavailable read is not 'nothing saved'", () => {
    assert.deepEqual(readSavedConnection({ kind: "unavailable" }), { kind: "unavailable" });
  });

  it("settings that are not a plain object are malformed, not empty", () => {
    for (const settings of [null, undefined, [], "x", 5, new Date(0), Object.create({})]) {
      assert.deepEqual(loaded(settings), { kind: "settings_malformed" });
    }
  });

  it("no own connection key is absent; other top-level keys are allowed", () => {
    assert.deepEqual(loaded({}), { kind: "absent" });
    assert.deepEqual(loaded({ other: { kept: true } }), { kind: "absent" });
  });

  it("a present connection key with a wrong value is invalid, never absent", () => {
    const cases: [unknown, string][] = [
      [null, "not_object"],
      [undefined, "not_object"],
      ["ws://127.0.0.1:6767/ws", "not_object"],
      [[], "not_object"],
      [{ version: 1, daemonUrl: DEFAULT, extra: 1 }, "unknown_field"],
      [{ daemonUrl: DEFAULT }, "unsupported_version"],
      [{ version: 2, daemonUrl: DEFAULT }, "unsupported_version"],
      [{ version: "1", daemonUrl: DEFAULT }, "unsupported_version"],
      [{ version: 1 }, "invalid_address"],
      [{ version: 1, daemonUrl: "ws://example.com:6767/ws" }, "invalid_address"],
    ];
    for (const [connection, error] of cases) {
      assert.deepEqual(loaded({ connection }), { kind: "invalid", error });
    }
  });

  it("a valid connection gives its canonical address, beside other keys", () => {
    assert.deepEqual(
      loaded({ other: 1, connection: { version: 1, daemonUrl: "WS://LOCALHOST:7000/ws" } }),
      { kind: "ok", daemonUrl: "ws://localhost:7000/ws" },
    );
  });
});

describe("interpretLegacyFile: every row of plan table 4.2", () => {
  const text = (value: unknown) =>
    interpretLegacyFile({ kind: "text", text: JSON.stringify(value) });

  it("missing: no connection, E1 missing", () => {
    assert.deepEqual(interpretLegacyFile({ kind: "missing" }), {
      connection: { kind: "absent" },
      target: { kind: "missing" },
    });
  });

  it("unreadable: an error, E1 unreadable", () => {
    assert.deepEqual(interpretLegacyFile({ kind: "unreadable" }), {
      connection: { kind: "error", error: "unreadable" },
      target: { kind: "unreadable" },
    });
  });

  it("malformed: not JSON, not an object, an unknown key, too large", () => {
    const malformed: LegacyFile = {
      connection: { kind: "error", error: "malformed" },
      target: { kind: "invalid" },
    };
    for (const raw of ["{", "[]", "null", '"x"', "5"]) {
      assert.deepEqual(interpretLegacyFile({ kind: "text", text: raw }), malformed);
    }
    assert.deepEqual(text({ ...TARGET, password: "x" }), malformed);
    // Counted in bytes, as the file size is: 2 bytes per "é".
    const big = JSON.stringify({ ...TARGET, daemonUrl: DEFAULT }).replace(
      "}",
      `${" ".repeat(MAX_LEGACY_BYTES)}}`,
    );
    assert.deepEqual(interpretLegacyFile({ kind: "text", text: big }), malformed);
    const fits = "é".repeat(MAX_LEGACY_BYTES / 2 - 10);
    assert.deepEqual(
      interpretLegacyFile({ kind: "text", text: `{"serverId":"${fits}"}` }).connection,
      { kind: "error", error: "invalid_target_only" },
      "within the byte limit it is parsed",
    );
    const over = "é".repeat(MAX_LEGACY_BYTES / 2);
    assert.deepEqual(
      interpretLegacyFile({ kind: "text", text: `{"serverId":"${over}"}` }),
      malformed,
    );
  });

  it("an explicit daemonUrl that is not valid: an address error; E1 by its own fields", () => {
    assert.deepEqual(text({ ...TARGET, daemonUrl: "ws://example.com:6767/ws" }), {
      connection: { kind: "error", error: "invalid_address" },
      target: { kind: "ok", target: TARGET },
    });
    assert.deepEqual(text({ daemonUrl: null }), {
      connection: { kind: "error", error: "invalid_address" },
      target: { kind: "invalid" },
    });
  });

  it("a valid explicit daemonUrl with an invalid or incomplete target still gives the address", () => {
    for (const fields of [
      { daemonUrl: "ws://localhost:7000/ws" },
      { serverId: TARGET.serverId, daemonUrl: "ws://localhost:7000/ws" },
      { ...TARGET, agentId: "bad/id", daemonUrl: "ws://localhost:7000/ws" },
    ]) {
      assert.deepEqual(text(fields), {
        connection: { kind: "address", daemonUrl: "ws://localhost:7000/ws", implicit: false },
        target: { kind: "invalid" },
      });
    }
  });

  it("a valid explicit daemonUrl and a valid target", () => {
    assert.deepEqual(text({ ...TARGET, daemonUrl: "WS://LOCALHOST:7000/ws" }), {
      connection: { kind: "address", daemonUrl: "ws://localhost:7000/ws", implicit: false },
      target: { kind: "ok", target: TARGET },
    });
  });

  it("no daemonUrl and a valid target: the default the file implies, as today", () => {
    assert.deepEqual(text(TARGET), {
      connection: { kind: "address", daemonUrl: DEFAULT, implicit: true },
      target: { kind: "ok", target: TARGET },
    });
  });

  it("no daemonUrl and an invalid or incomplete target: an error, never the default", () => {
    for (const fields of [{}, { serverId: TARGET.serverId }, { ...TARGET, serverId: 5 }]) {
      assert.deepEqual(text(fields), {
        connection: { kind: "error", error: "invalid_target_only" },
        target: { kind: "invalid" },
      });
    }
  });

  it("results carry no file content", () => {
    const result = text({ serverId: "srv_secret-marker", agentId: "x/y" });
    assert.equal(JSON.stringify(result).includes("secret-marker"), false);
  });
});

describe("chooseConnection: every row of plan table 4.3", () => {
  const savedOk: SavedConnection = { kind: "ok", daemonUrl: "ws://localhost:7000/ws" };
  const legacyAddress: LegacyConnection = {
    kind: "address",
    daemonUrl: "ws://localhost:8000/ws",
    implicit: false,
  };
  const legacies: LegacyConnection[] = [
    { kind: "absent" },
    legacyAddress,
    { kind: "error", error: "malformed" },
  ];

  it("an unavailable read blocks, whatever the legacy file says", () => {
    for (const legacy of legacies) {
      assert.deepEqual(chooseConnection({ kind: "unavailable" }, legacy), {
        kind: "blocked",
        reason: "settings_unavailable",
      });
    }
  });

  it("malformed settings block, whatever the legacy file says", () => {
    for (const legacy of legacies) {
      assert.deepEqual(chooseConnection({ kind: "settings_malformed" }, legacy), {
        kind: "blocked",
        reason: "settings_malformed",
      });
    }
  });

  it("a valid saved connection wins over any legacy file", () => {
    for (const legacy of legacies) {
      assert.deepEqual(chooseConnection(savedOk, legacy), {
        kind: "connect",
        daemonUrl: "ws://localhost:7000/ws",
        source: "saved",
      });
    }
  });

  it("an invalid saved connection blocks and never falls back to legacy or default", () => {
    for (const legacy of legacies) {
      assert.deepEqual(chooseConnection({ kind: "invalid", error: "unknown_field" }, legacy), {
        kind: "blocked",
        reason: "saved_invalid",
      });
    }
  });

  it("nothing saved: the legacy address, explicit or implicit", () => {
    assert.deepEqual(chooseConnection({ kind: "absent" }, legacyAddress), {
      kind: "connect",
      daemonUrl: "ws://localhost:8000/ws",
      source: "legacy",
    });
    assert.deepEqual(
      chooseConnection({ kind: "absent" }, { kind: "address", daemonUrl: DEFAULT, implicit: true }),
      { kind: "connect", daemonUrl: DEFAULT, source: "legacy" },
    );
  });

  it("nothing saved and a legacy error: blocked with that error, not the default", () => {
    const expected: [LegacyConnection, ConnectionChoice][] = [
      [
        { kind: "error", error: "unreadable" },
        { kind: "blocked", reason: "legacy_unreadable" },
      ],
      [
        { kind: "error", error: "malformed" },
        { kind: "blocked", reason: "legacy_malformed" },
      ],
      [
        { kind: "error", error: "invalid_address" },
        { kind: "blocked", reason: "legacy_invalid_address" },
      ],
      [
        { kind: "error", error: "invalid_target_only" },
        { kind: "blocked", reason: "legacy_invalid_target_only" },
      ],
    ];
    for (const [legacy, choice] of expected) {
      assert.deepEqual(chooseConnection({ kind: "absent" }, legacy), choice);
    }
  });

  it("the default only when nothing is saved and no legacy file exists", () => {
    assert.deepEqual(chooseConnection({ kind: "absent" }, { kind: "absent" }), {
      kind: "connect",
      daemonUrl: DEFAULT,
      source: "default",
    });
  });

  it("end to end: an E1 target error does not block a valid explicit legacy address", () => {
    const legacy = interpretLegacyFile({
      kind: "text",
      text: JSON.stringify({ daemonUrl: "ws://[::1]:7000/ws" }),
    });
    assert.deepEqual(legacy.target, { kind: "invalid" });
    assert.deepEqual(chooseConnection({ kind: "absent" }, legacy.connection), {
      kind: "connect",
      daemonUrl: "ws://[::1]:7000/ws",
      source: "legacy",
    });
  });
});
