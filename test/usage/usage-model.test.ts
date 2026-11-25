import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isWellFormed } from "../../src/paseo/unknown-value.ts";
import { formatReset, formatUsed, parseUsageList } from "../../src/usage/usage-model.ts";

/**
 * Shaped like a real listUsage response (daemon 0.15.4, read-only check of
 * 2026-11-16: Claude 5h, weekly and one model-scoped weekly window; Codex a
 * weekly window and a credits balance). All values are synthetic.
 */
const NOW = Date.parse("2026-11-16T12:00:00.000Z");
function realShape(): Record<string, unknown> {
  return {
    requestId: "req-1",
    fetchedAt: "2026-11-16T11:58:00.000Z",
    providers: [
      {
        providerId: "codex",
        displayName: "Codex",
        status: "available",
        planLabel: "synthetic-plan",
        windows: [
          {
            id: "weekly",
            label: "Weekly",
            shortLabel: "wk",
            summary: true,
            usedPct: 12,
            resetsAt: "2026-11-20T00:00:00.000Z",
            tone: "ok",
          },
        ],
        balances: [{ id: "credits", label: "Credits", remaining: 40, unit: "credits" }],
      },
      {
        providerId: "claude",
        displayName: "Claude",
        status: "available",
        planLabel: "synthetic-plan",
        error: "synthetic-error-text",
        windows: [
          {
            id: "weekly_model_fable",
            label: "Weekly Fable",
            shortLabel: "wk Fable",
            usedPct: 30,
            resetsAt: "2026-11-21T00:00:00.000Z",
          },
          {
            id: "weekly",
            label: "Weekly",
            shortLabel: "wk",
            summary: true,
            usedPct: 55,
            resetsAt: "2026-11-21T00:00:00.000Z",
            tone: "warning",
          },
          {
            id: "five_hour",
            label: "Session",
            shortLabel: "5h",
            summary: true,
            usedPct: 91.6,
            resetsAt: "2026-11-16T13:30:00.000Z",
            tone: "danger",
          },
        ],
      },
    ],
  };
}

describe("parseUsageList", () => {
  it("reads a real-shaped response into a stable dial order", () => {
    const snapshot = parseUsageList(realShape());
    assert.ok(snapshot);
    assert.equal(snapshot.collectedAt, Date.parse("2026-11-16T11:58:00.000Z"));
    assert.deepEqual(
      snapshot.providers.map((provider) => [provider.providerId, provider.status]),
      [
        ["claude", "available"],
        ["codex", "available"],
      ],
    );
    assert.deepEqual(
      snapshot.entries.map((entry) => `${entry.providerId}/${entry.kind}/${entry.id}`),
      [
        "claude/window/five_hour",
        "claude/window/weekly",
        "claude/window/weekly_model_fable",
        "codex/window/weekly",
        "codex/balance/credits",
      ],
    );
    const session = snapshot.entries[0];
    assert.ok(session?.kind === "window");
    assert.equal(session.usedPct, 91.6);
    assert.equal(session.tone, "danger");
    assert.equal(session.shortLabel, "5h");
    assert.equal(snapshot.skipped, 0);
  });

  it("keeps the order and keys when the response order changes", () => {
    const first = parseUsageList(realShape());
    const shuffled = realShape();
    const providers = shuffled["providers"];
    assert.ok(Array.isArray(providers));
    providers.reverse();
    const second = parseUsageList(shuffled);
    assert.deepEqual(
      second?.entries.map((entry) => entry.key),
      first?.entries.map((entry) => entry.key),
    );
  });

  it("keeps no provider error text, plan or account label", () => {
    const serialized = JSON.stringify(parseUsageList(realShape()));
    assert.doesNotMatch(serialized, /synthetic-error-text|synthetic-plan/);
  });

  it("treats missing or invalid values as unknown, never zero, with a neutral tone", () => {
    const snapshot = parseUsageList({
      fetchedAt: "not a date",
      providers: [
        {
          providerId: "p",
          displayName: "P",
          status: "available",
          windows: [
            { id: "a", label: "A" },
            { id: "b", label: "B", usedPct: Number.NaN, resetsAt: "soon", tone: "default" },
            { id: "c", label: "C", usedPct: -5, resetsAt: 12, tone: "purple" },
            { id: "d", label: "D", usedPct: "50" },
          ],
          balances: [{ id: "x", label: "X", unit: "usd", used: Infinity }],
        },
      ],
    });
    assert.ok(snapshot);
    assert.equal(snapshot.collectedAt, null);
    for (const entry of snapshot.entries) {
      assert.equal(entry.resetsAt, null, entry.id);
      assert.equal(entry.tone, "neutral", entry.id);
      if (entry.kind === "window") assert.equal(entry.usedPct, null, entry.id);
      else assert.equal(entry.used, null);
    }
    assert.equal(formatUsed(null), "—");
  });

  it("skips malformed and duplicate providers, windows and balances, keeping the rest", () => {
    const snapshot = parseUsageList({
      providers: [
        null,
        { providerId: "", status: "available", windows: [] },
        { providerId: "q", status: "sleeping", windows: [] },
        {
          providerId: "p",
          displayName: "P",
          status: "available",
          windows: [{ id: "w", label: "W" }],
        },
        { providerId: "p", displayName: "P2", status: "available", windows: [] },
        {
          providerId: "r",
          displayName: "R",
          status: "error",
          windows: "nope",
          balances: [
            { id: "b", label: "B", unit: "coins" },
            { id: "b", label: "B", unit: "usd" },
            { id: "b", label: "B again", unit: "usd" },
            { label: "no id", unit: "usd" },
          ],
        },
        {
          providerId: "s",
          displayName: "S",
          status: "unavailable",
          windows: [{ id: "w", label: "W" }, { id: "w", label: "W2" }, { id: "x" }, 7],
        },
      ],
    });
    assert.ok(snapshot);
    assert.deepEqual(
      snapshot.providers.map((provider) => `${provider.providerId}:${provider.status}`),
      ["p:available", "r:error", "s:unavailable"],
    );
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.key),
      [
        JSON.stringify(["p", "window", "w"]),
        JSON.stringify(["r", "balance", "b"]),
        JSON.stringify(["s", "window", "w"]),
      ],
    );
    assert.equal(snapshot.skipped, 10);
  });

  it("keeps window and balance IDs apart, and lets a skipped provider not claim its ID", () => {
    const snapshot = parseUsageList({
      providers: [
        { providerId: "p", status: "sleeping", windows: [{ id: "x", label: "Lost" }] },
        {
          providerId: "p",
          status: "available",
          windows: [{ id: "same", label: "Window" }],
          balances: [{ id: "same", label: "Balance", unit: "credits" }],
        },
      ],
    });
    assert.ok(snapshot);
    assert.deepEqual(
      snapshot.providers.map((provider) => provider.status),
      ["available"],
    );
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.key),
      [JSON.stringify(["p", "window", "same"]), JSON.stringify(["p", "balance", "same"])],
    );
    assert.equal(snapshot.skipped, 1, "only the provider with the unknown status");
  });

  it("works for a provider with no windows or balances at all", () => {
    const snapshot = parseUsageList({
      providers: [{ providerId: "p", displayName: "P", status: "unavailable" }],
    });
    assert.ok(snapshot);
    assert.deepEqual(snapshot.entries, []);
    assert.equal(snapshot.providers.length, 1);
  });

  it("returns null for a payload that is not a usage list", () => {
    for (const payload of [null, "x", {}, { providers: "x" }]) {
      assert.equal(parseUsageList(payload), null);
    }
  });
});

describe("parseUsageList boundary values", () => {
  const windows = (items: unknown[]) =>
    parseUsageList({
      providers: [{ providerId: "p", displayName: "P", status: "available", windows: items }],
    });
  const graphemes = (text: string) =>
    Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)).length;

  it("keeps IDs exactly, so IDs that differ only in spaces stay distinct", () => {
    const snapshot = windows([
      { id: " w", label: "A" },
      { id: "w", label: "B" },
      { id: "   ", label: "blank" },
      { id: "bad\uD800", label: "lone surrogate" },
    ]);
    assert.ok(snapshot);
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.id),
      [" w", "w"],
    );
    assert.notEqual(snapshot.entries[0]?.key, snapshot.entries[1]?.key);
    assert.equal(snapshot.skipped, 2, "blank and ill-formed IDs are rejected, never repaired");
  });

  it("keeps labels well-formed and caps them by grapheme", () => {
    const snapshot = windows([
      { id: "a", label: `${"a".repeat(119)}😀b` },
      { id: "b", label: "ok\uD800bad" },
      { id: "c", label: "line\u0007break" },
    ]);
    assert.ok(snapshot);
    const [atCap, surrogate, control] = snapshot.entries.map((entry) => entry.label);
    assert.ok(atCap?.endsWith("😀"), "the emoji at the cap stays whole");
    assert.equal(graphemes(atCap ?? ""), 120);
    assert.equal(surrogate, "ok\uFFFDbad", "a lone surrogate is replaced deliberately");
    assert.equal(control, "line break");
    for (const text of [atCap, surrogate, control]) assert.ok(isWellFormed(text ?? ""));
  });

  it("accepts only real ISO timestamps with a timezone", () => {
    const at = (resetsAt: string) =>
      windows([{ id: "x", label: "X", resetsAt }])?.entries[0]?.resetsAt;
    for (const invalid of [
      "2026-02-30T12:00:00Z",
      "2026-02-29T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-11-16T24:00:00Z",
      "2026-11-16T12:60:00Z",
      "2026-11-16T12:00:00",
      "2026-11-16",
      "Nov 16 2026 12:00 GMT",
      "2026-11-16T12:00:00+24:00",
    ]) {
      assert.equal(at(invalid), null, invalid);
    }
    assert.equal(at("2028-02-29T00:00:00Z"), Date.UTC(2028, 1, 29), "leap day");
    assert.equal(at("2026-11-16T12:00:00+02:00"), Date.UTC(2026, 10, 16, 10), "offset");
    assert.equal(at("2026-11-16T12:00:00-05:30"), Date.UTC(2026, 10, 16, 17, 30));
    assert.equal(at("2026-11-16T12:00:00.123456Z"), Date.UTC(2026, 10, 16, 12, 0, 0, 123));
    assert.equal(at("2026-11-16T12:00Z"), Date.UTC(2026, 10, 16, 12), "seconds optional");
  });

  it("keeps years 0000–0099 instead of shifting them to 1900–1999", () => {
    const iso = (fetchedAt: string) => {
      const collectedAt = parseUsageList({ providers: [], fetchedAt })?.collectedAt;
      return collectedAt == null ? null : new Date(collectedAt).toISOString();
    };
    assert.equal(iso("0099-01-01T00:00:00Z"), "0099-01-01T00:00:00.000Z");
    assert.equal(iso("0050-06-15T23:30:00+01:00"), "0050-06-15T22:30:00.000Z");
    // Proleptic Gregorian: year 0 is a leap year, 1900 is not.
    assert.equal(iso("0000-02-29T12:00:00Z"), "0000-02-29T12:00:00.000Z");
    assert.equal(iso("0100-02-29T00:00:00Z"), null);
  });

  it("never shows a countdown for an impossible date", () => {
    const resetsAt = windows([{ id: "x", label: "X", resetsAt: "2026-02-30T12:00:00Z" }])
      ?.entries[0]?.resetsAt;
    assert.equal(formatReset(resetsAt ?? null, NOW), null);
  });
});

describe("formatReset", () => {
  it("counts down from an injected now, in minutes, hours or days", () => {
    assert.equal(formatReset(NOW + 30_000, NOW), "Resets in 1m");
    assert.equal(formatReset(NOW + 45 * 60_000, NOW), "Resets in 45m");
    assert.equal(formatReset(NOW + 90 * 60_000, NOW), "Resets in 1h 30m");
    assert.equal(formatReset(NOW + 3 * 86_400_000 + 2 * 3_600_000, NOW), "Resets in 3d 2h");
  });

  it("never claims a refreshed quota and never shows a countdown for an unknown time", () => {
    assert.equal(formatReset(NOW, NOW), "Reset due");
    assert.equal(formatReset(NOW - 60_000, NOW), "Reset due");
    assert.equal(formatReset(null, NOW), null);
    assert.equal(formatReset(NOW + 60_000, Number.NaN), null);
    assert.equal(formatReset(Number.POSITIVE_INFINITY, NOW), null);
    assert.equal(formatReset(Number.NaN, NOW), null);
  });
});

describe("formatUsed", () => {
  it("rounds a known percentage and keeps values above 100", () => {
    assert.equal(formatUsed(91.6), "92% used");
    assert.equal(formatUsed(0), "0% used");
    assert.equal(formatUsed(104), "104% used");
  });
});
