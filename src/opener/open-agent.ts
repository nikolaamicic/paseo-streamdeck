import { execFile } from "node:child_process";
import type { AgentAddress } from "../agents/agent-model.ts";
import { agentDeepLink, isAgentDeepLinkFor } from "./agent-deep-link.ts";

/** macOS launcher; the URL is one separate argument, never shell text. */
export const OPEN_EXECUTABLE = "/usr/bin/open";
const OPEN_TIMEOUT_MS = 10_000;

/** Runs a program with separate arguments; rejects on a non-zero exit or timeout. */
export type ProcessRunner = (file: string, args: readonly string[]) => Promise<void>;

export const execFileRunner: ProcessRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { shell: false, timeout: OPEN_TIMEOUT_MS }, (error) => {
      if (error) reject(new Error("process failed"));
      else resolve();
    });
  });

/**
 * Stable outcome codes; no URL, ID or process output is returned, so callers
 * cannot log them by accident. "requested" means only that macOS accepted
 * the request, not which screen Paseo shows.
 */
export type OpenOutcome = "requested" | "invalid_target" | "unsupported_platform" | "launch_failed";

export async function openAgent(
  address: AgentAddress,
  run: ProcessRunner = execFileRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenOutcome> {
  if (platform !== "darwin") return "unsupported_platform";
  const url = agentDeepLink(address);
  // Re-checked right before launch so a refactor cannot pass another URL.
  if (url === null || !isAgentDeepLinkFor(url, address)) return "invalid_target";
  try {
    await run(OPEN_EXECUTABLE, [url]);
    return "requested";
  } catch {
    return "launch_failed";
  }
}
