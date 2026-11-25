import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideSave,
  knownSaves,
  toJsonObject,
  type SaveFacts,
} from "../../src/connection/connection-save.ts";
import type { KnownSettings } from "../../src/connection/settings-reader.ts";

/** The pure Save decision (C4a1) over narrow facts; no SDK, no lifecycle. */

const A = "ws://localhost:7001/ws";
const B = "ws://localhost:7002/ws";
const loaded = (settings: Record<string, unknown>): KnownSettings => ({ kind: "loaded", settings });
const saved = (daemonUrl: string) => ({ connection: { version: 1, daemonUrl } });
const facts = (known: KnownSettings, active: SaveFacts["active"] = null): SaveFacts => ({
  known,
  active,
});

describe("decideSave", () => {
  it("an invalid address writes nothing, whatever is known", () => {
    const cases: [unknown, string][] = [
      [42, "not_string"],
      ["", "empty"],
      ["ws://localhost:65536/ws", "port_out_of_range"],
      ["ws://example.com:7000/ws", "invalid_format"],
    ];
    for (const [raw, error] of cases) {
      for (const known of [loaded({}), { kind: "none" } as const]) {
        assert.deepEqual(decideSave(raw, facts(known)), { kind: "invalid", error });
      }
    }
  });

  it("no reliable whole object (none or malformed) blocks the write", () => {
    assert.deepEqual(decideSave(A, facts({ kind: "none" })), { kind: "not_loaded" });
    assert.deepEqual(decideSave(A, facts({ kind: "malformed" })), { kind: "malformed" });
  });

  it("the saved and active address is the one no-op, also when typed differently", () => {
    const known = loaded(saved(A));
    const active = { daemonUrl: A, source: "saved" } as const;
    assert.deepEqual(decideSave(A, facts(known, active)), { kind: "unchanged" });
    assert.deepEqual(decideSave("ws://LOCALHOST:7001/ws", facts(known, active)), {
      kind: "unchanged",
    });
  });

  it("an already saved address that is not active is not written again", () => {
    const known = loaded(saved(B));
    for (const active of [null, { daemonUrl: A, source: "saved" } as const]) {
      assert.deepEqual(decideSave(B, facts(known, active)), { kind: "saved_not_active" });
    }
  });

  it("an active legacy or default address is written; only connection changes", () => {
    for (const source of ["legacy", "default"] as const) {
      const known = loaded({ other: { nested: [1, "x", null, true] }, keep: 3 });
      const decision = decideSave(A, facts(known, { daemonUrl: A, source }));
      assert.deepEqual(decision, {
        kind: "write",
        daemonUrl: A,
        settings: { other: { nested: [1, "x", null, true] }, keep: 3, ...saved(A) },
      });
    }
  });

  it("a new address replaces a valid or invalid saved connection, normalized", () => {
    for (const before of [saved(A), { connection: null }, { connection: { version: 2 } }]) {
      const decision = decideSave("ws://LocalHost:7002/ws", facts(loaded(before)));
      assert.equal(decision.kind, "write");
      assert.deepEqual(decision.settings, saved(B));
      assert.equal(decision.daemonUrl, B);
    }
  });

  it("known settings that are not JSON are never sent in part", () => {
    for (const bad of [Number.NaN, Infinity, () => 1, new Date(0), { deep: undefined }]) {
      assert.deepEqual(decideSave(A, facts(loaded({ bad }))), { kind: "not_json" });
    }
  });
});

describe("toJsonObject", () => {
  it("copies every key and value, also __proto__, without sharing objects", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"x":1},"list":[{"y":2}],"n":-0.5}');
    assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
    const source = Object.fromEntries(Object.entries(parsed));
    const copy = toJsonObject(source);
    assert.ok(copy);
    assert.deepEqual(Object.keys(copy), ["__proto__", "list", "n"]);
    assert.equal(Object.getPrototypeOf(copy), Object.prototype, "the prototype is not replaced");
    assert.deepEqual(JSON.stringify(copy), JSON.stringify(parsed));
    assert.notEqual(copy["list"], source["list"]);
  });

  it("a value nested deeper than the bound is refused", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let level = 0; level < 70; level += 1) {
      const inner = {};
      deep["d"] = inner;
      deep = inner;
    }
    assert.equal(toJsonObject(root), null);
    assert.ok(toJsonObject({ d: { d: { d: {} } } }));
  });
});

describe("knownSaves", () => {
  it("is true only for a loaded object whose valid connection is the address", () => {
    assert.equal(knownSaves(loaded(saved(A)), A), true);
    assert.equal(knownSaves(loaded(saved(A)), B), false);
    assert.equal(knownSaves(loaded({ connection: null }), A), false);
    assert.equal(knownSaves({ kind: "none" }, A), false);
    assert.equal(knownSaves({ kind: "malformed" }, A), false);
  });
});
