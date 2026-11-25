/**
 * Shared record of the SDK adapter check (M11c). Only the child process
 * started by test/spike/sdk-adapters.test.ts loads this: the import hooks,
 * the fake SDK, the fake runtime and the child test all record here, in one
 * ordered event log, so the test can assert a real order.
 */

/** One call the plugin's SDK classes made on a runtime event port. */
export interface PortCall {
  readonly port: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface HarnessState {
  /** logger, runtime, signal, register, connect, start, shutdown, … in order. */
  readonly events: string[];
  readonly calls: PortCall[];
  /** The action instances plugin.ts registered, in order. */
  readonly registered: object[];
  /** Views the fake SDK ui delivered to an open inspector. */
  readonly inspector: unknown[];
  /** The real packages that got loaded; must stay empty. */
  readonly loadedPackages: Set<string>;
  /** The action whose inspector is open in the fake SDK ui. */
  uiAction: { readonly id: string } | null;
  /** The deps plugin.ts passed to createPluginRuntime. */
  deps: unknown;
  /** When set, the next async port call rejects with it (await checks). */
  rejectNext: Error | null;
  /** When set, the next call of this "port.method" rejects with `rejectNext`. */
  rejectOnly: string | null;
  /** What the fake SDK settings return or deliver (C3a3 forwarding checks). */
  readonly settings: {
    /** The value the next getGlobalSettings resolves with. */
    answer: unknown;
    /** The listeners registered through onDidReceiveGlobalSettings, live. */
    readonly listeners: ((ev: { readonly settings: unknown }) => void)[];
    /** Each setGlobalSettings call: its `this` and the object it got (C4a2). */
    readonly writes: { readonly self: unknown; readonly settings: unknown }[];
    /** When set, the next setGlobalSettings rejects with it. */
    refuseNextWrite: Error | null;
  };
}

export const harness: HarnessState = {
  events: [],
  calls: [],
  registered: [],
  inspector: [],
  loadedPackages: new Set(),
  uiAction: null,
  deps: null,
  rejectNext: null,
  rejectOnly: null,
  settings: { answer: null, listeners: [], writes: [], refuseNextWrite: null },
};
