import type { PaseoClientConfig, PaseoLogger } from "@getpaseo/client";

/**
 * @getpaseo/client 0.15.4 logs through `config.logger`, defaulting to a
 * console logger that prints raw objects (errors, validation messages). This
 * replacement drops every argument and reports only the level, so nothing
 * from the SDK reaches logs as raw text. Debug/info are dropped.
 */
export type SdkLogLevel = "warn" | "error";

export function createSdkLogger(report: (level: SdkLogLevel) => void): PaseoLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => {
      report("warn");
    },
    error: () => {
      report("error");
    },
  };
}

const CONNECT_TIMEOUT_MS = 5_000;

/** Client configuration with the safe logger always installed. */
export function paseoClientConfig(
  url: string,
  report: (level: SdkLogLevel) => void,
): PaseoClientConfig {
  return { url, connectTimeoutMs: CONNECT_TIMEOUT_MS, logger: createSdkLogger(report) };
}
