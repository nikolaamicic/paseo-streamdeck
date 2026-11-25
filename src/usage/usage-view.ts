import {
  formatReset,
  formatUsed,
  type ProviderUsage,
  type UsageBalanceEntry,
  type UsageEntry,
  type UsageSnapshot,
  type UsageTone,
  type UsageWindowEntry,
} from "./usage-model.ts";
import { knownEntryName } from "./usage-names.ts";
import type { UsageState } from "./usage-poller.ts";

/**
 * What the Usage dial shows. Pure,
 * so every case is testable without the Stream Deck SDK. Colors follow only
 * the tone the daemon reports; the plugin adds no thresholds of its own.
 * Unknown values are shown as unknown, never as 0, and "used" is never
 * derived from "left" in text (nor the reverse).
 */

/** One position of the dial: a window, a balance, or a provider without any. */
export type UsageItem =
  | { readonly kind: "entry"; readonly key: string; readonly entry: UsageEntry }
  | { readonly kind: "provider"; readonly key: string; readonly provider: ProviderUsage };

/** Feed facts the dial needs besides the usage itself. */
export interface UsageFacts {
  readonly connected: boolean;
}

/** Semantic color roles; the Elgato UI maps them to concrete colors. */
export type ValueInk = "normal" | "warning" | "danger" | "muted";

export interface UsageDisplay {
  readonly title: string;
  /** "2/5"; empty without items. */
  readonly counter: string;
  readonly value: string;
  readonly ink: ValueInk;
  /** Fill 0–100 of the used part; null shows no bar. */
  readonly bar: number | null;
  readonly hint: string;
}

/**
 * Dial positions in the model's order (providers by name; main windows,
 * scoped windows, balances). A provider reporting `error` or `unavailable`
 * gets exactly one position showing that status, even if it also sent
 * windows or balances: those cannot be trusted as current. An available
 * provider that reports nothing keeps one position too, so it stays
 * visible.
 */
export function usageItems(snapshot: UsageSnapshot): UsageItem[] {
  return snapshot.providers.flatMap((provider): UsageItem[] => {
    const entries = snapshot.entries.filter((entry) => entry.providerId === provider.providerId);
    if (provider.status !== "available" || entries.length === 0) {
      return [
        { kind: "provider", key: JSON.stringify([provider.providerId, "provider"]), provider },
      ];
    }
    return entries.map((entry) => ({ kind: "entry", key: entry.key, entry }));
  });
}

/** Position of `key`, or 0 when it is gone or none was chosen. */
export function usageIndex(items: readonly UsageItem[], key: string | null): number {
  const index = key === null ? -1 : items.findIndex((item) => item.key === key);
  return Math.max(0, index);
}

function toneInk(tone: UsageTone): ValueInk {
  return tone === "warning" ? "warning" : tone === "danger" ? "danger" : "normal";
}

const clampPct = (value: number) => Math.min(100, Math.max(0, value));

const numberFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const usdFormat = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function amountText(balance: UsageBalanceEntry, amount: number): string {
  return balance.unit === "usd" ? usdFormat.format(amount) : numberFormat.format(amount);
}

function windowDisplay(entry: UsageWindowEntry, now: number) {
  const reset = formatReset(entry.resetsAt, now);
  const ink = toneInk(entry.tone);
  if (entry.usedPct !== null) {
    return {
      value: formatUsed(entry.usedPct),
      ink,
      bar: clampPct(entry.usedPct),
      hint: reset ?? "No reset time",
    };
  }
  if (entry.remainingPct !== null) {
    return {
      value: `${Math.round(entry.remainingPct)}% left`,
      ink,
      bar: null,
      hint: reset ?? "No reset time",
    };
  }
  const toneHint = entry.tone === "warning" || entry.tone === "danger";
  return {
    value: "—",
    ink,
    bar: null,
    hint: reset ?? (toneHint ? `Provider tone: ${entry.tone}` : "No percentage reported"),
  };
}

/**
 * A balance bar needs a finite limit above 0 and a value to compare with
 * it; without one there is no ratio. The bar shows the used part: `used`
 * when reported, else what `remaining` leaves of the limit. Text above the
 * limit stays as reported; only the bar is clamped.
 */
function balanceBar(balance: UsageBalanceEntry): number | null {
  const limit = balance.limit;
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return null;
  if (balance.used !== null) return clampPct((balance.used / limit) * 100);
  if (balance.remaining !== null) return clampPct(100 - (balance.remaining / limit) * 100);
  return null;
}

function balanceDisplay(balance: UsageBalanceEntry, now: number) {
  const reset = formatReset(balance.resetsAt, now);
  const value =
    balance.remaining !== null
      ? `${amountText(balance, balance.remaining)} left`
      : balance.used !== null
        ? `${amountText(balance, balance.used)} used`
        : "—";
  const unit = balance.unit === "usd" ? "" : ` ${balance.unit}`;
  let hint: string;
  if (balance.limit !== null) {
    hint = `of ${amountText(balance, balance.limit)}${unit}`;
    if (reset !== null) hint += ` · ${reset}`;
  } else if (balance.unit === "usd") {
    hint = reset ?? "No reset time";
  } else {
    hint = `${balance.unit} · no limit reported`;
  }
  return { value, ink: toneInk(balance.tone), bar: balanceBar(balance), hint };
}

function providerDisplay(provider: ProviderUsage) {
  switch (provider.status) {
    case "unavailable":
      return {
        value: "Unavailable",
        ink: "muted" as const,
        bar: null,
        hint: "No usage from this provider",
      };
    case "error":
      return {
        value: "Usage error",
        ink: "danger" as const,
        bar: null,
        hint: "Provider reported an error",
      };
    case "available":
      return { value: "No usage data", ink: "muted" as const, bar: null, hint: "Nothing reported" };
  }
}

function itemTitle(item: UsageItem): string {
  if (item.kind === "provider") return item.provider.name;
  const entry = item.entry;
  const own = entry.kind === "window" ? (entry.shortLabel ?? entry.label) : entry.label;
  return `${entry.providerName} · ${knownEntryName(entry.key) ?? own}`;
}

function message(value: string, hint: string): UsageDisplay {
  return { title: "Usage", counter: "", value, ink: "muted", bar: null, hint };
}

/**
 * The dial's display for the item at `index` (clamped). Data that is not
 * confirmed by the last request (offline, or the request failed) is shown
 * muted, without tone or reset time, and marked "last known"; no age is
 * claimed either way, since the daemon may serve cached usage.
 */
export function usageDisplay(
  state: UsageState,
  facts: UsageFacts,
  index: number,
  now: number,
): UsageDisplay {
  const snapshot = state.snapshot;
  if (snapshot === null) {
    if (!facts.connected) return message("Offline", "No usage data yet");
    if (state.failed) return message("Not available", "Usage request failed");
    return message("Loading…", "");
  }
  const lastKnown = !facts.connected
    ? "Offline · last known"
    : state.failed
      ? "Not updated · last known"
      : state.outdated
        ? "Updating · last known"
        : null;
  const items = usageItems(snapshot);
  if (items.length === 0) return message("No usage data", lastKnown ?? "No providers report usage");
  const position = Math.min(Math.max(0, index), items.length - 1);
  const item = items[position];
  if (item === undefined) return message("No usage data", "No providers report usage");
  const shown =
    item.kind === "provider"
      ? providerDisplay(item.provider)
      : item.entry.kind === "window"
        ? windowDisplay(item.entry, now)
        : balanceDisplay(item.entry, now);
  const base = {
    title: itemTitle(item),
    counter: `${position + 1}/${items.length}`,
  };
  if (lastKnown !== null) {
    return { ...base, value: shown.value, ink: "muted", bar: shown.bar, hint: lastKnown };
  }
  return { ...base, ...shown };
}
