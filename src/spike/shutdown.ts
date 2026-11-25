import { within, type Timers } from "../paseo/deadline.ts";

/**
 * Graceful plugin shutdown. @elgato/streamdeck 3.0.4 documents no shutdown
 * event and does not react to its own socket closing; Stream Deck manages
 * the plugin process. A terminating signal (SIGTERM, SIGINT) is therefore
 * the only hook. Whether Stream Deck sends one or kills the process is not
 * documented or verified; if the process is killed, only the operating
 * system closes the daemon connection.
 */

/** Bound for the graceful part, so the process always exits. */
export const SHUTDOWN_GRACE_MS = 2_000;

export type ShutdownOutcome = "clean" | "timeout" | "failed";

export interface ShutdownSteps {
  /** Stops all key drawing; runs first. */
  disposeKeys(): void;
  /** Stops the recovery owner, which closes the feed and its client. */
  stopRecovery(): Promise<void>;
  exit(): void;
  readonly timers: Timers;
  onOutcome?(outcome: ShutdownOutcome): void;
  readonly graceMs?: number;
}

export interface Shutdown {
  /** Runs the shutdown once; later calls return the same promise. */
  run(): Promise<void>;
  readonly started: boolean;
}

export function createShutdown(steps: ShutdownSteps): Shutdown {
  let running: Promise<void> | null = null;

  async function shutdown(): Promise<void> {
    try {
      steps.disposeKeys();
    } catch {
      // Keys are best effort; the connection must still be closed.
    }
    const stopping = Promise.resolve().then(() => steps.stopRecovery());
    const result = await within(stopping, steps.graceMs ?? SHUTDOWN_GRACE_MS, steps.timers).settled;
    const outcome: ShutdownOutcome =
      result.kind === "value" ? "clean" : result.kind === "timeout" ? "timeout" : "failed";
    try {
      steps.onOutcome?.(outcome);
    } catch {
      // Logging is best effort; exiting is not.
    }
    steps.exit();
  }

  return {
    run: () => {
      running ??= shutdown();
      return running;
    },
    get started() {
      return running !== null;
    },
  };
}
