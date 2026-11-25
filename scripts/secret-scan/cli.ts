import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureGitleaks, GITLEAKS_VERSION, platformKey } from "./gitleaks-binary.ts";
import { historyScanArgs, runGitleaks, stagedScanArgs, type ScanResult } from "./scan.ts";
import { runSelfTest } from "./selftest.ts";

/**
 * Secret scanning entry point (Gitleaks, pinned in gitleaks-binary.ts).
 *   staged        scan the staged changes (pre-commit hook)
 *   history       scan every commit reachable from any ref
 *   selftest      prove detection and redaction in a throwaway repository
 *   install-hook  enable .githooks/ for this repository only
 *   hook-status   report whether the pre-commit hook is active here
 */

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CACHE_DIR = join(REPO_ROOT, ".cache", "gitleaks");
const HOOKS_PATH = ".githooks";

function say(message: string): void {
  process.stdout.write(`[secret-scan] ${message}\n`);
}

function scanner(): Promise<string> {
  return ensureGitleaks({
    cacheDir: CACHE_DIR,
    target: platformKey(process.platform, process.arch),
    log: say,
  });
}

function report(kind: string, result: ScanResult): number {
  switch (result.outcome) {
    case "clean":
      say(`${kind}: no leaks found`);
      return 0;
    case "leaks":
      say(`${kind}: FAILED, possible secrets found (values redacted above)`);
      return 1;
    case "error":
      say(`${kind}: FAILED, scanner error (exit code ${String(result.exitCode)})`);
      return 1;
  }
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: REPO_ROOT, timeout: 30_000 });
  return stdout.trim();
}

async function hookStatus(): Promise<number> {
  // `git config --get` exits non-zero when the key is not set.
  const configured = await git("config", "--local", "--get", "core.hooksPath").catch(() => "");
  const hook = join(REPO_ROOT, HOOKS_PATH, "pre-commit");
  let executable = true;
  try {
    await access(hook, constants.X_OK);
  } catch {
    executable = false;
  }
  const active = configured === HOOKS_PATH && executable;
  say(`core.hooksPath (repository config): ${configured === "" ? "<not set>" : configured}`);
  say(`${HOOKS_PATH}/pre-commit executable in this worktree: ${executable ? "yes" : "no"}`);
  say(active ? "pre-commit secret scan is ACTIVE here" : "pre-commit secret scan is NOT active");
  return active ? 0 : 1;
}

async function main(command: string | undefined): Promise<number> {
  switch (command) {
    case "staged":
      return report(
        "staged changes",
        await runGitleaks(await scanner(), stagedScanArgs(REPO_ROOT)),
      );
    case "history":
      return report("git history", await runGitleaks(await scanner(), historyScanArgs(REPO_ROOT)));
    case "selftest": {
      say(`Gitleaks ${GITLEAKS_VERSION} self-test in a temporary repository`);
      const checks = await runSelfTest(await scanner());
      for (const check of checks) say(`${check.passed ? "PASS" : "FAIL"}  ${check.name}`);
      const passed = checks.length > 0 && checks.every((check) => check.passed);
      say(passed ? "self-test passed" : "self-test FAILED");
      return passed ? 0 : 1;
    }
    case "install-hook":
      // Shared by all worktrees of this repository; branches without
      // .githooks/ simply have no pre-commit hook. Never global.
      await git("config", "--local", "core.hooksPath", HOOKS_PATH);
      return hookStatus();
    case "hook-status":
      return hookStatus();
    case undefined:
    default:
      say(
        "usage: node scripts/secret-scan/cli.ts <staged|history|selftest|install-hook|hook-status>",
      );
      return 64;
  }
}

try {
  process.exitCode = await main(process.argv[2]);
} catch (error: unknown) {
  say(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
