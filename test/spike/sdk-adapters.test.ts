import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Runs the SDK adapter check (M11c) in a child process: the import hooks
 * (test/support/sdk-harness/hooks.ts) and the globals the check stubs
 * (process.once while plugin.ts loads) never reach this process or other
 * test files. The child imports the real src/spike/plugin.ts with a fake
 * Stream Deck SDK, a fake Paseo client package and a fake runtime; see
 * adapters.child.ts for what it proves and what it does not.
 */

const harnessFile = (name: string) =>
  fileURLToPath(new URL(`../support/sdk-harness/${name}`, import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** Generous: the child normally finishes in well under a second. */
const CHILD_TIMEOUT_MS = 60_000;

interface ChildResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly output: string;
}

function runChild(): Promise<ChildResult> {
  // The parent runner marks its own children; the check is a standalone run.
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", harnessFile("hooks.ts"), "--test", harnessFile("adapters.child.ts")],
      { cwd: ROOT, env, timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, signal: error?.signal ?? null, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

describe("SDK adapters and registration (child process)", () => {
  it("the real plugin.ts passes the adapter check under a fake SDK and runtime", async () => {
    const result = await runChild();
    assert.equal(
      result.code,
      0,
      `the child failed (signal ${String(result.signal)}):\n${result.output}`,
    );
    assert.match(
      result.output,
      /ℹ pass 13\b/,
      "all thirteen checks ran (the E1 key check went with the action)",
    );
    assert.match(result.output, /ℹ fail 0\b/);
  });
});
