import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { historyScanArgs, runGitleaks, stagedScanArgs, type ScanOutcome } from "./scan.ts";

/**
 * End-to-end check of the real scanner in a throwaway repository outside the
 * project. The synthetic token is generated in memory for each run, has the
 * shape of a GitHub personal access token (`ghp_` + 36 alphanumerics) and is
 * never committed to the project, written to the project tree or printed.
 */

const execFileAsync = promisify(execFile);
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function syntheticToken(): string {
  let body = "";
  for (let i = 0; i < 36; i += 1) body += TOKEN_ALPHABET.charAt(randomInt(TOKEN_ALPHABET.length));
  return `ghp_${body}`;
}

/** Child git/gitleaks runs must not inherit hook-time or user git settings. */
export function isolatedGitEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  return env;
}

export interface SelfTestCheck {
  readonly name: string;
  readonly passed: boolean;
}

export async function runSelfTest(binary: string): Promise<SelfTestCheck[]> {
  const repo = await mkdtemp(join(tmpdir(), "secret-scan-selftest-"));
  const env = isolatedGitEnv(process.env);
  const token = syntheticToken();
  const checks: SelfTestCheck[] = [];

  const git = async (...args: string[]): Promise<void> => {
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=secret-scan-selftest",
        "-c",
        "user.email=selftest@example.invalid",
        ...args,
      ],
      { cwd: repo, env, timeout: 30_000 },
    );
  };
  const scan = (args: string[]) => runGitleaks(binary, args, { capture: true, cwd: repo, env });
  const expect = (
    name: string,
    result: { outcome: ScanOutcome; output: string },
    outcome: ScanOutcome,
  ): void => {
    // A finding must be reported with its value replaced, never verbatim.
    const redacted =
      !result.output.includes(token) && (outcome !== "leaks" || result.output.includes("REDACTED"));
    checks.push({ name, passed: result.outcome === outcome && redacted });
    if (!redacted) checks.push({ name: `${name}: output was not redacted`, passed: false });
  };

  try {
    await git("init", "-q", "-b", "main");
    await writeFile(join(repo, "README.md"), "clean content\n");
    await git("add", "README.md");
    await git("commit", "-q", "-m", "clean commit");
    expect("clean history passes", await scan(historyScanArgs(repo)), "clean");

    const leaky = join(repo, "settings.txt");
    await writeFile(leaky, `token = ${token}\n`);
    expect("unstaged secret is outside the staged scan", await scan(stagedScanArgs(repo)), "clean");

    await git("add", "settings.txt");
    const staged = await scan(stagedScanArgs(repo));
    expect("staged secret fails (redacted output)", staged, "leaks");

    await git("commit", "-q", "-m", "add settings");
    await unlink(leaky);
    await git("commit", "-q", "-am", "remove settings");
    expect(
      "secret committed and later deleted fails the history scan",
      await scan(historyScanArgs(repo)),
      "leaks",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
  return checks;
}
