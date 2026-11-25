import { hasLoneSurrogate } from "../text/display-text.ts";

/**
 * Small readers for daemon data received as `unknown`, shared by the agent
 * and workspace parsers.
 */

export type UnknownRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Identities must be well-formed UTF-16: map keys and deep links pass them
 * through encodeURIComponent, which throws on a lone surrogate. Such an ID is
 * rejected, never repaired, because replacing characters would change the
 * identity and could make two IDs collide.
 */
export function isWellFormed(text: string): boolean {
  return !hasLoneSurrogate(text);
}

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((candidate) => candidate === value);
}
