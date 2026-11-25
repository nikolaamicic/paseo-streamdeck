/**
 * Names shown on the Usage dial (the owner's decision after the device check
 * of 2026-11-16): "Claude · 5h", "Claude · Weekly", "Claude · Fable
 * Weekly", "Codex · Weekly", "Codex · Credits". The provider name comes
 * from the stable `providerId`, never from the response's `displayName`,
 * which was seen to carry account details. Known IDs are those of the
 * redacted listUsage probe (daemon 0.15.4);
 * the table only names items the daemon actually returns and never adds
 * any. Unknown providers show their ID, unknown windows and balances their
 * own label.
 */

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
};

/** Keyed by JSON [providerId, kind, id], like UsageEntry.key. */
const ENTRY_NAMES: Readonly<Record<string, string>> = {
  [JSON.stringify(["claude", "window", "five_hour"])]: "5h",
  [JSON.stringify(["claude", "window", "weekly"])]: "Weekly",
  [JSON.stringify(["claude", "window", "weekly_model_fable"])]: "Fable Weekly",
  [JSON.stringify(["codex", "window", "weekly"])]: "Weekly",
  [JSON.stringify(["codex", "balance", "credits"])]: "Credits",
};

/** The provider's shown name: a known name, else its ID. */
export function providerName(providerId: string): string {
  return Object.hasOwn(PROVIDER_NAMES, providerId)
    ? (PROVIDER_NAMES[providerId] ?? providerId)
    : providerId;
}

/** A known entry's shown name by its key; null for others. */
export function knownEntryName(entryKey: string): string | null {
  return Object.hasOwn(ENTRY_NAMES, entryKey) ? (ENTRY_NAMES[entryKey] ?? null) : null;
}
