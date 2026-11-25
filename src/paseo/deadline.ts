/** One-shot timers, injectable so tests can use a manual clock. */
export interface Timers {
  after(delayMs: number, callback: () => void): { cancel(): void };
}

export const systemTimers: Timers = {
  after: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs);
    return {
      cancel: () => {
        clearTimeout(handle);
      },
    };
  },
};

export type Settled<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" };

export interface Deadline<T> {
  /** Settles exactly once: with the result, on timeout, or on cancel(). */
  readonly settled: Promise<Settled<T>>;
  /** Clears the timer and settles as "cancelled" unless already settled. */
  cancel(): void;
}

/**
 * Waits for `operation` at most `delayMs`. The timer is cleared as soon as
 * the wait settles, and a result that arrives afterwards is ignored (a late
 * rejection is handled, never unhandled). This cannot cancel the operation
 * itself: the owner must release whatever it holds, e.g. by closing the
 * client, and call cancel() so no timer outlives it.
 */
export function within<T>(operation: Promise<T>, delayMs: number, timers: Timers): Deadline<T> {
  let finish: (result: Settled<T>) => void = () => undefined;
  const settled = new Promise<Settled<T>>((resolve) => {
    let done = false;
    finish = (result) => {
      if (done) return;
      done = true;
      timer.cancel();
      resolve(result);
    };
  });
  const timer = timers.after(delayMs, () => {
    finish({ kind: "timeout" });
  });
  operation.then(
    (value) => {
      finish({ kind: "value", value });
    },
    (error: unknown) => {
      finish({ kind: "error", error });
    },
  );
  return {
    settled,
    cancel: () => {
      finish({ kind: "cancelled" });
    },
  };
}
