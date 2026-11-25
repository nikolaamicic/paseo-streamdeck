import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyExit,
  historyScanArgs,
  LEAKS_EXIT_CODE,
  stagedScanArgs,
} from "../../scripts/secret-scan/scan.ts";
import { isolatedGitEnv, syntheticToken } from "../../scripts/secret-scan/selftest.ts";

describe("scan arguments", () => {
  for (const [name, args] of [
    ["staged", stagedScanArgs("/repo")],
    ["history", historyScanArgs("/repo")],
  ] as const) {
    it(`${name} scan redacts values, writes no report and ignores inline allow comments`, () => {
      assert.ok(args.includes("--redact"));
      assert.ok(args.includes("--ignore-gitleaks-allow"));
      assert.ok(args.includes(`--exit-code=${LEAKS_EXIT_CODE}`));
      assert.equal(
        args.some((arg) => arg.startsWith("--report-path") || arg === "-r"),
        false,
      );
      assert.equal(args.at(-1), "/repo");
    });
  }

  it("scans the index, not the working tree, before a commit", () => {
    const args = stagedScanArgs("/repo");
    assert.deepEqual(args.slice(0, 3), ["git", "--pre-commit", "--staged"]);
  });

  it("scans every commit of every ref for history", () => {
    assert.ok(historyScanArgs("/repo").includes("--log-opts=--all"));
  });
});

describe("classifyExit", () => {
  it("separates findings from scanner errors; only 0 is clean", () => {
    assert.equal(classifyExit(0), "clean");
    assert.equal(classifyExit(LEAKS_EXIT_CODE), "leaks");
    assert.equal(classifyExit(1), "error");
    assert.equal(classifyExit(126), "error");
    assert.equal(classifyExit(null), "error");
  });
});

describe("self-test helpers", () => {
  it("generates a fresh token of the GitHub PAT shape each time", () => {
    const first = syntheticToken();
    assert.match(first, /^ghp_[A-Za-z0-9]{36}$/);
    assert.notEqual(first, syntheticToken());
  });

  it("drops hook-time GIT_* variables and user git config for child processes", () => {
    const env = isolatedGitEnv({
      PATH: "/usr/bin",
      GIT_INDEX_FILE: "/repo/.git/index",
      GIT_DIR: "/repo/.git",
    });
    assert.equal(env["PATH"], "/usr/bin");
    assert.equal(env["GIT_INDEX_FILE"], undefined);
    assert.equal(env["GIT_DIR"], undefined);
    assert.equal(env["GIT_CONFIG_GLOBAL"], "/dev/null");
    assert.equal(env["GIT_CONFIG_NOSYSTEM"], "1");
  });
});
