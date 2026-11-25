import { isOneOf, isRecord, isWellFormed } from "../paseo/unknown-value.ts";
import { cleanDisplayText, graphemes } from "../text/display-text.ts";
import { providerName } from "./usage-names.ts";

/**
 * Account quota usage (U1): the payload of the public
 * `client.providers.listUsage()` (@getpaseo/client 0.15.4, protocol
 * `provider.usage.list.response`), read at the boundary into what a dial
 * needs. These are account-wide quota windows of a provider (e.g. Claude's
 * 5-hour session); they say nothing about why a particular agent's turn
 * ended, and are never turned into an agent status.
 *
 * Kept: provider and window identity, window and balance labels,
 * percentages, balances, reset times and tone. Not kept: provider error
 * text, plan label and the provider's `displayName`, which can carry
 * account details (seen on the device, 2026-11-16); the provider name comes
 * from its ID (usage-names.ts).
 * A missing or invalid value is unknown (null), never 0.
 */

export type UsageTone = "ok" | "warning" | "danger" | "neutral";
export type ProviderUsageStatus = "available" | "unavailable" | "error";
export type BalanceUnit = "tokens" | "usd" | "credits" | "requests";

export interface ProviderUsage {
  readonly providerId: string;
  readonly name: string;
  readonly status: ProviderUsageStatus;
}

interface EntryBase {
  /** Stable identity across refreshes: provider, kind and the daemon's own ID. */
  readonly key: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly id: string;
  readonly label: string;
  /** Epoch milliseconds, or null when unknown or invalid. */
  readonly resetsAt: number | null;
  readonly tone: UsageTone;
}

export interface UsageWindowEntry extends EntryBase {
  readonly kind: "window";
  readonly shortLabel: string | null;
  /** A main window (e.g. session, weekly) rather than a scoped one. */
  readonly summary: boolean;
  readonly usedPct: number | null;
  readonly remainingPct: number | null;
}

export interface UsageBalanceEntry extends EntryBase {
  readonly kind: "balance";
  readonly unit: BalanceUnit;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly limit: number | null;
}

export type UsageEntry = UsageWindowEntry | UsageBalanceEntry;

export interface UsageSnapshot {
  /**
   * The response's `fetchedAt` (epoch ms), or null. Per the daemon source it
   * is when the daemon answered; its data may come from a cache (5 minutes
   * in daemon 0.15.4) and is not proven to be the provider's fetch time.
   */
  readonly collectedAt: number | null;
  readonly providers: readonly ProviderUsage[];
  /** Ordered for a dial: see orderEntries. */
  readonly entries: readonly UsageEntry[];
  /** Providers, windows or balances skipped as malformed or duplicate. */
  readonly skipped: number;
}

const TONES: readonly UsageTone[] = ["ok", "warning", "danger"];
const STATUSES: readonly ProviderUsageStatus[] = ["available", "unavailable", "error"];
const UNITS: readonly BalanceUnit[] = ["tokens", "usd", "credits", "requests"];
/** Longest ID (UTF-16 units) and label (graphemes); longer IDs are skipped, labels cut. */
const MAX_ID = 200;
const MAX_LABEL = 120;

/**
 * An ID exactly as the daemon sent it: IDs are opaque, so they are never
 * trimmed or repaired. Empty, whitespace-only, too long or ill-formed
 * (lone surrogate) IDs are rejected.
 */
function id(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.length <= MAX_ID && isWellFormed(value) ? value : null;
}

/**
 * Display text: control characters become spaces and lone surrogates
 * become U+FFFD, so the result is always well-formed; capped at MAX_LABEL
 * graphemes (never splitting one). Null when nothing visible remains.
 */
function label(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = cleanDisplayText(value);
  if (clean === "") return null;
  const parts = graphemes(clean);
  return parts.length <= MAX_LABEL ? clean : parts.slice(0, MAX_LABEL).join("").trimEnd();
}

/** A finite, non-negative number; anything else is unknown. */
function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * ISO 8601 date-time with seconds optional, fraction optional and an
 * explicit timezone (Z or ±HH:MM). Date.parse is not used: it accepts
 * impossible dates (2026-02-30 becomes March 2) and dates without a zone.
 */
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Epoch ms for a UTC date-time. Date.UTC maps years 0–99 to 1900–1999, so
 * the full year is set separately; time parts are applied on 2000-01-01
 * first, where in-range values cannot overflow into another day.
 */
function utcMillis(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millis = 0,
): number {
  return new Date(Date.UTC(2000, 0, 1, hour, minute, second, millis)).setUTCFullYear(
    year,
    monthIndex,
    day,
  );
}

function daysInMonth(year: number, month: number): number {
  return new Date(utcMillis(year, month, 0)).getUTCDate();
}

/** A valid timestamp with a timezone, as epoch ms; anything else is unknown. */
function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = ISO_TIMESTAMP.exec(value);
  if (match === null) return null;
  const [, y, mo, d, h, mi, se = "0", fraction = "", zone, oh = "0", om = "0"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(se);
  const offsetHours = Number(oh);
  const offsetMinutes = Number(om);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  ) {
    return null;
  }
  const millis = Math.floor(Number(`0.${fraction || "0"}`) * 1000);
  const sign = zone?.startsWith("-") === true ? -1 : 1;
  const offset = zone === "Z" ? 0 : sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  return utcMillis(year, month - 1, day, hour, minute, second, millis) - offset;
}

function tone(value: unknown): UsageTone {
  return isOneOf(TONES, value) ? value : "neutral";
}

function key(providerId: string, kind: UsageEntry["kind"], entryId: string): string {
  return JSON.stringify([providerId, kind, entryId]);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function byId(a: UsageEntry, b: UsageEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Dial order (implementation choice): providers by name, then ID; within a
 * provider its main windows, then scoped windows, then balances, each by ID.
 * The order does not depend on the order of the response.
 */
function orderEntries(
  providers: readonly ProviderUsage[],
  entries: readonly UsageEntry[],
): UsageEntry[] {
  const rank = (entry: UsageEntry) => (entry.kind === "balance" ? 2 : entry.summary ? 0 : 1);
  return providers.flatMap((provider) =>
    entries
      .filter((entry) => entry.providerId === provider.providerId)
      .sort((a, b) => rank(a) - rank(b) || byId(a, b)),
  );
}

/**
 * One window of a provider, or null when it must be skipped: not an object,
 * no valid ID or label, or a window ID already seen for this provider. An
 * accepted ID is added to `seen` (windows and balances use separate keys).
 */
function parseWindow(
  window: unknown,
  providerId: string,
  providerName: string,
  seen: Set<string>,
): UsageWindowEntry | null {
  const entryId = isRecord(window) ? id(window["id"]) : null;
  const windowLabel = isRecord(window) ? label(window["label"]) : null;
  if (!isRecord(window) || entryId === null || windowLabel === null || seen.has(`w${entryId}`)) {
    return null;
  }
  seen.add(`w${entryId}`);
  return {
    kind: "window",
    key: key(providerId, "window", entryId),
    providerId,
    providerName,
    id: entryId,
    label: windowLabel,
    shortLabel: label(window["shortLabel"]),
    summary: window["summary"] === true,
    usedPct: amount(window["usedPct"]),
    remainingPct: amount(window["remainingPct"]),
    resetsAt: timestamp(window["resetsAt"]),
    tone: tone(window["tone"]),
  };
}

/**
 * One balance of a provider, or null when it must be skipped: not an object,
 * no valid ID or label, an unknown unit, or a balance ID already seen for
 * this provider. An accepted ID is added to `seen`.
 */
function parseBalance(
  balance: unknown,
  providerId: string,
  providerName: string,
  seen: Set<string>,
): UsageBalanceEntry | null {
  const entryId = isRecord(balance) ? id(balance["id"]) : null;
  const balanceLabel = isRecord(balance) ? label(balance["label"]) : null;
  const unit = isRecord(balance) ? balance["unit"] : null;
  if (
    !isRecord(balance) ||
    entryId === null ||
    balanceLabel === null ||
    !isOneOf(UNITS, unit) ||
    seen.has(`b${entryId}`)
  ) {
    return null;
  }
  seen.add(`b${entryId}`);
  return {
    kind: "balance",
    key: key(providerId, "balance", entryId),
    providerId,
    providerName,
    id: entryId,
    label: balanceLabel,
    unit,
    used: amount(balance["used"]),
    remaining: amount(balance["remaining"]),
    limit: amount(balance["limit"]),
    resetsAt: timestamp(balance["resetsAt"]),
    tone: tone(balance["tone"]),
  };
}

/** Reads the listUsage payload; null when it is not a usage list at all. */
export function parseUsageList(payload: unknown): UsageSnapshot | null {
  if (!isRecord(payload) || !Array.isArray(payload["providers"])) return null;
  let skipped = 0;
  const providers: ProviderUsage[] = [];
  const entries: UsageEntry[] = [];
  const seenProviders = new Set<string>();
  for (const raw of payload["providers"]) {
    if (!isRecord(raw)) {
      skipped += 1;
      continue;
    }
    const providerId = id(raw["providerId"]);
    const status = raw["status"];
    if (providerId === null || seenProviders.has(providerId) || !isOneOf(STATUSES, status)) {
      skipped += 1;
      continue;
    }
    seenProviders.add(providerId);
    const name = providerName(providerId);
    providers.push({ providerId, name, status });
    const seenEntries = new Set<string>();
    for (const window of list(raw["windows"])) {
      const entry = parseWindow(window, providerId, name, seenEntries);
      if (entry === null) skipped += 1;
      else entries.push(entry);
    }
    for (const balance of list(raw["balances"])) {
      const entry = parseBalance(balance, providerId, name, seenEntries);
      if (entry === null) skipped += 1;
      else entries.push(entry);
    }
  }
  providers.sort(
    (a, b) =>
      collator.compare(a.name, b.name) ||
      (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0),
  );
  return {
    collectedAt: timestamp(payload["fetchedAt"]),
    providers,
    entries: orderEntries(providers, entries),
    skipped,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Time until a reset, for display. Null when the reset time is unknown. A
 * reset time that has passed says only that it was due: the quota is not
 * known to be refreshed until new data arrives.
 */
export function formatReset(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt) || !Number.isFinite(now)) return null;
  const left = resetsAt - now;
  if (left <= 0) return "Reset due";
  if (left < HOUR) return `Resets in ${Math.max(1, Math.ceil(left / MINUTE))}m`;
  if (left < DAY) {
    const hours = Math.floor(left / HOUR);
    const minutes = Math.floor((left % HOUR) / MINUTE);
    return `Resets in ${hours}h ${minutes}m`;
  }
  const days = Math.floor(left / DAY);
  const hours = Math.floor((left % DAY) / HOUR);
  return `Resets in ${days}d ${hours}h`;
}

/** Used percentage for display; "—" when unknown, never 0. */
export function formatUsed(usedPct: number | null): string {
  return usedPct === null ? "—" : `${Math.round(usedPct)}% used`;
}
