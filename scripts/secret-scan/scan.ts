import { spawn } from "node:child_process";

/**
 * Gitleaks invocation. Every scan redacts secret values from its output, never
 * writes report files, and ignores inline `gitleaks:allow` comments so a
 * commit cannot silence its own finding. A distinct exit code separates
 * findings from scanner errors; both fail the caller.
 */
export const LEAKS_EXIT_CODE = 2;

const COMMON_FLAGS: readonly string[] = [
  "--no-banner",
  "--no-color",
  "--redact",
  "--verbose",
  "--ignore-gitleaks-allow",
  `--exit-code=${LEAKS_EXIT_CODE}`,
];

/** Changes staged in the index, i.e. exactly what the next commit contains. */
export function stagedScanArgs(repo: string): string[] {
  return ["git", "--pre-commit", "--staged", ...COMMON_FLAGS, repo];
}

/** Every commit reachable from any ref, so removed secrets are still found. */
export function historyScanArgs(repo: string): string[] {
  return ["git", "--log-opts=--all", ...COMMON_FLAGS, repo];
}

export type ScanOutcome = "clean" | "leaks" | "error";

export function classifyExit(code: number | null): ScanOutcome {
  if (code === 0) return "clean";
  if (code === LEAKS_EXIT_CODE) return "leaks";
  return "error";
}

export interface ScanResult {
  readonly outcome: ScanOutcome;
  readonly exitCode: number | null;
  /** Combined output; only present when captured. Secret values are redacted. */
  readonly output: string;
}

export interface RunOptions {
  /** Capture output instead of streaming it to this process. */
  readonly capture?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function runGitleaks(
  binary: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio:
        options.capture === true ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        outcome: classifyExit(code),
        exitCode: code,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}
