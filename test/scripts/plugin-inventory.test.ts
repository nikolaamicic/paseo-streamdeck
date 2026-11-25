import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXPECTED_FILES, inventoryProblems } from "../../scripts/plugin/inventory.ts";

const MANIFEST = JSON.stringify({ Nodejs: { Version: "24" } });
const read =
  (overrides: Record<string, string> = {}) =>
  (file: string): string =>
    overrides[file] ?? (file === "manifest.json" ? MANIFEST : "clean");

describe("inventoryProblems", () => {
  it("accepts exactly the expected, clean files", () => {
    assert.deepEqual(inventoryProblems([...EXPECTED_FILES], read()), []);
  });

  it("rejects extra files such as logs or local config, and missing files", () => {
    const problems = inventoryProblems(
      [...EXPECTED_FILES.filter((file) => file !== "bin/plugin.js"), "logs/plugin.log", ".env"],
      read(),
    );
    assert.deepEqual(problems.sort(), [
      "missing file: bin/plugin.js",
      "unexpected file: .env",
      "unexpected file: logs/plugin.log",
    ]);
  });

  it("rejects private paths, server IDs and credentials in text files", () => {
    const problems = inventoryProblems(
      [...EXPECTED_FILES],
      read({
        "bin/plugin.js": 'const a = "/Users/someone/x"; const b = "srv_AbCdEf123";',
        "THIRD_PARTY_NOTICES.txt": "-----BEGIN RSA PRIVATE KEY-----",
      }),
    );
    assert.ok(problems.includes("macOS home path found in bin/plugin.js"));
    assert.ok(problems.includes("Paseo server ID found in bin/plugin.js"));
    assert.ok(problems.includes("private key found in THIRD_PARTY_NOTICES.txt"));
  });

  it("rejects Node imports in the inspector's browser scripts (C4b)", () => {
    const problems = inventoryProblems(
      [...EXPECTED_FILES],
      read({
        "ui/connection.js": 'const fs = require("node:fs");',
        "ui/workspace.js": "import x from 'y';",
      }),
    );
    assert.deepEqual(problems, [
      "a node: import in the browser script ui/connection.js",
      "a require call in the browser script ui/connection.js",
      "a module import in the browser script ui/workspace.js",
    ]);
    assert.deepEqual(
      inventoryProblems([...EXPECTED_FILES], read({ "bin/plugin.js": 'import "node:fs";' })),
      [],
      "the Node plugin itself may import Node",
    );
  });

  it("rejects a manifest that enables the debugger or another Node version", () => {
    const debug = JSON.stringify({ Nodejs: { Version: "24", Debug: "enabled" } });
    assert.deepEqual(inventoryProblems([...EXPECTED_FILES], read({ "manifest.json": debug })), [
      "manifest enables the Node.js debugger",
    ]);
    const node20 = JSON.stringify({ Nodejs: { Version: "20" } });
    assert.deepEqual(inventoryProblems([...EXPECTED_FILES], read({ "manifest.json": node20 })), [
      "manifest Nodejs.Version is not 24",
    ]);
  });
});
