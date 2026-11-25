import type { ActionName } from "./action-ids.ts";

/**
 * The plugin's start sequence (M11a), as plugin.ts ran it at the end of the
 * module: hook the terminating signals, register every action, then connect
 * to Stream Deck and start the feed. Signal hooks and registrations stay
 * outside the try/catch, as before; only connect and startFeed failures are
 * caught and logged as one fixed code, never as a raw error.
 */

export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export interface BootstrapDeps<A> {
  /** Registers a one-time handler (process.once). */
  readonly onceSignal: (signal: ShutdownSignal, handler: () => void) => void;
  readonly runShutdown: () => Promise<void>;
  readonly order: readonly ActionName[];
  readonly createAction: (name: ActionName) => A;
  readonly registerAction: (action: A) => void;
  readonly connect: () => Promise<void>;
  readonly startFeed: () => Promise<void>;
  readonly logStartFailed: () => void;
}

export async function bootstrapPlugin<A>(deps: BootstrapDeps<A>): Promise<void> {
  for (const signal of SHUTDOWN_SIGNALS) {
    deps.onceSignal(signal, () => {
      void deps.runShutdown();
    });
  }
  for (const name of deps.order) deps.registerAction(deps.createAction(name));
  // Unexpected rejections are logged as codes; raw errors never reach the log.
  try {
    await deps.connect();
    await deps.startFeed();
  } catch {
    deps.logStartFailed();
  }
}
