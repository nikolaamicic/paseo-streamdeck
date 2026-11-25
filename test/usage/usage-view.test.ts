import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUsageList, type UsageSnapshot } from "../../src/usage/usage-model.ts";
import type { UsageState } from "../../src/usage/usage-poller.ts";
import { usageDisplay, usageIndex, usageItems } from "../../src/usage/usage-view.ts";

/** Synthetic values only. */
const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const IN_2H = "2026-11-16T14:14:00.000Z";

function snapshot(providers: unknown[]): UsageSnapshot {
  const parsed = parseUsageList({ fetchedAt: "2026-11-16T12:00:00Z", providers });
  assert.ok(parsed);
  return parsed;
}

const live = (data: UsageSnapshot): UsageState => ({
  snapshot: data,
  failed: false,
  pending: false,
  outdated: false,
});
const CONNECTED = { connected: true };

function show(windows: unknown[] = [], balances: unknown[] = [], index = 0) {
  const data = snapshot([
    { providerId: "claude", displayName: "Claude", status: "available", windows, balances },
  ]);
  return usageDisplay(live(data), CONNECTED, index, NOW);
}

describe("usageItems", () => {
  it("lists every reported window and balance, and a provider that reports none", () => {
    const items = usageItems(
      snapshot([
        {
          providerId: "codex",
          displayName: "Codex",
          status: "available",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 5 }],
          balances: [{ id: "credits", label: "Credits", remaining: 1, unit: "credits" }],
        },
        { providerId: "gemini", displayName: "Gemini", status: "unavailable" },
        {
          providerId: "claude",
          displayName: "Claude",
          status: "available",
          windows: [
            { id: "5h", label: "5 hours", summary: true, usedPct: 1 },
            { id: "opus", label: "Opus weekly", usedPct: 2 },
          ],
        },
      ]),
    );
    assert.deepEqual(
      items.map((item) => (item.kind === "provider" ? item.provider.providerId : item.entry.id)),
      ["5h", "opus", "weekly", "credits", "gemini"],
    );
    assert.equal(usageIndex(items, items[3]?.key ?? null), 3, "kept by key");
    assert.equal(usageIndex(items, "gone"), 0, "a vanished item falls back to the first");
  });
});

describe("usageDisplay: windows", () => {
  it("shows used %, the bar and the reset time, colored only by the reported tone", () => {
    assert.deepEqual(
      show([{ id: "5h", label: "5 hours", shortLabel: "5h", usedPct: 62, resetsAt: IN_2H }]),
      {
        title: "Claude · 5h",
        counter: "1/1",
        value: "62% used",
        ink: "normal",
        bar: 62,
        hint: "Resets in 2h 14m",
      },
    );
    assert.equal(show([{ id: "w", label: "W", usedPct: 99, tone: "ok" }]).ink, "normal");
    assert.equal(show([{ id: "w", label: "W", usedPct: 10, tone: "warning" }]).ink, "warning");
    assert.equal(show([{ id: "w", label: "W", usedPct: 10, tone: "danger" }]).ink, "danger");
  });

  it("keeps text above 100 % as reported and clamps only the bar", () => {
    const over = show([{ id: "w", label: "W", usedPct: 130 }]);
    assert.equal(over.value, "130% used");
    assert.equal(over.bar, 100);
  });

  it("never turns an unknown percentage into 0 and never derives used from left", () => {
    const left = show([{ id: "w", label: "W", remainingPct: 38 }]);
    assert.equal(left.value, "38% left");
    assert.equal(left.bar, null);
    const none = show([{ id: "w", label: "W" }]);
    assert.equal(none.value, "—");
    assert.equal(none.bar, null);
    assert.equal(none.hint, "No percentage reported");
    assert.equal(show([{ id: "w", label: "W", tone: "danger" }]).hint, "Provider tone: danger");
    assert.equal(show([{ id: "w", label: "W", usedPct: 5 }]).hint, "No reset time");
  });
});

describe("usageDisplay: balances", () => {
  it("draws a bar only with a finite limit above 0 and a value to compare", () => {
    const full = show(
      [],
      [{ id: "c", label: "Credits", remaining: 1250, limit: 5000, unit: "credits" }],
    );
    assert.equal(full.value, "1,250 left");
    assert.equal(full.bar, 75, "the used part of the limit");
    assert.equal(full.hint, "of 5,000 credits");
    const used = show(
      [],
      [{ id: "c", label: "Credits", used: 6000, limit: 5000, unit: "credits" }],
    );
    assert.equal(used.value, "6,000 used", "text above the limit stays as reported");
    assert.equal(used.bar, 100);
    for (const limit of [0, undefined]) {
      const shown = show([], [{ id: "c", label: "Credits", remaining: 3, limit, unit: "tokens" }]);
      assert.equal(shown.bar, null, `limit ${String(limit)}`);
    }
    const onlyLimit = show([], [{ id: "c", label: "Credits", limit: 10, unit: "credits" }]);
    assert.equal(onlyLimit.value, "—");
    assert.equal(onlyLimit.bar, null, "no value to compare: no bar, no division");
    assert.equal(
      show([], [{ id: "c", label: "Credits", remaining: 3, unit: "requests" }]).hint,
      "requests · no limit reported",
    );
  });

  it("formats dollars", () => {
    const usd = show(
      [],
      [{ id: "u", label: "Spend", remaining: 42.5, unit: "usd", resetsAt: IN_2H }],
    );
    assert.equal(usd.value, "$42.50 left");
    assert.equal(usd.hint, "Resets in 2h 14m");
  });
});

describe("usageDisplay: states", () => {
  const data = snapshot([
    {
      providerId: "claude",
      displayName: "Claude",
      status: "available",
      windows: [{ id: "5h", label: "5h", usedPct: 62, tone: "danger", resetsAt: IN_2H }],
    },
    { providerId: "codex", displayName: "Codex", status: "error" },
    { providerId: "gemini", displayName: "Gemini", status: "unavailable" },
  ]);

  it("before data, offline, failed and empty", () => {
    const none: UsageState = { snapshot: null, failed: false, pending: true, outdated: false };
    assert.equal(usageDisplay(none, CONNECTED, 0, NOW).value, "Loading…");
    assert.equal(usageDisplay(none, { connected: false }, 0, NOW).value, "Offline");
    assert.equal(usageDisplay({ ...none, failed: true }, CONNECTED, 0, NOW).value, "Not available");
    assert.equal(usageDisplay(live(snapshot([])), CONNECTED, 0, NOW).value, "No usage data");
  });

  it("marks last known data muted, without tone or reset time, and claims no age", () => {
    const offline = usageDisplay(live(data), { connected: false }, 0, NOW);
    assert.deepEqual(
      { value: offline.value, ink: offline.ink, hint: offline.hint },
      { value: "62% used", ink: "muted", hint: "Offline · last known" },
    );
    const failed = usageDisplay({ ...live(data), failed: true }, CONNECTED, 0, NOW);
    assert.equal(failed.hint, "Not updated · last known");
    assert.equal(failed.ink, "muted");
  });

  it("shows provider status without its error text, and clamps the position", () => {
    assert.deepEqual(usageDisplay(live(data), CONNECTED, 1, NOW), {
      title: "Codex",
      counter: "2/3",
      value: "Usage error",
      ink: "danger",
      bar: null,
      hint: "Provider reported an error",
    });
    assert.equal(usageDisplay(live(data), CONNECTED, 9, NOW).counter, "3/3");
    assert.equal(usageDisplay(live(data), CONNECTED, 9, NOW).value, "Unavailable");
  });
});

describe("usageDisplay: provider status dominates its data", () => {
  for (const status of ["error", "unavailable"] as const) {
    it(`a provider with status ${status} shows that status, never its windows or balances`, () => {
      const data = snapshot([
        {
          providerId: "claude",
          displayName: "Claude",
          status,
          windows: [{ id: "w", label: "Window", usedPct: 12, tone: "ok" }],
          balances: [{ id: "c", label: "Credits", remaining: 5, limit: 10, unit: "credits" }],
        },
      ]);
      const items = usageItems(data);
      assert.equal(items.length, 1);
      const shown = usageDisplay(live(data), CONNECTED, 0, NOW);
      assert.equal(shown.title, "Claude");
      assert.equal(shown.counter, "1/1");
      assert.notEqual(shown.value, "12% used");
      assert.notEqual(shown.ink, "normal");
      assert.equal(shown.bar, null);
    });
  }
});

describe("usageDisplay: an empty answer still shows the connection state", () => {
  it("marks an empty last answer as last known when offline or not updated", () => {
    const empty = live(snapshot([]));
    assert.equal(usageDisplay(empty, CONNECTED, 0, NOW).hint, "No providers report usage");
    assert.equal(usageDisplay(empty, { connected: false }, 0, NOW).hint, "Offline · last known");
    assert.equal(
      usageDisplay({ ...empty, failed: true }, CONNECTED, 0, NOW).hint,
      "Not updated · last known",
    );
  });
});

describe("usageDisplay: data of an earlier connection", () => {
  it("is shown muted as updating until a new answer arrives", () => {
    const data = snapshot([
      {
        providerId: "claude",
        displayName: "Claude",
        status: "available",
        windows: [{ id: "5h", label: "5h", usedPct: 62, tone: "danger", resetsAt: IN_2H }],
      },
    ]);
    const shown = usageDisplay({ ...live(data), outdated: true }, CONNECTED, 0, NOW);
    assert.equal(shown.hint, "Updating · last known");
    assert.equal(shown.ink, "muted", "no tone from an earlier connection");
    assert.equal(shown.value, "62% used");
  });
});

describe("usage titles never show the account and use the agreed names", () => {
  const ACCOUNT = "Someone's plan · person@example.invalid";
  const data = snapshot([
    {
      providerId: "claude",
      displayName: ACCOUNT,
      status: "available",
      windows: [
        { id: "five_hour", label: "Current session", usedPct: 47 },
        { id: "weekly", label: "Current week (all models)", usedPct: 20 },
        { id: "weekly_model_fable", label: "Current week (Fable)", usedPct: 5 },
        { id: "monthly_new", label: "Monthly", shortLabel: "Mo", usedPct: 1 },
      ],
    },
    {
      providerId: "codex",
      displayName: ACCOUNT,
      status: "available",
      windows: [{ id: "weekly", label: "Weekly limit", usedPct: 9 }],
      balances: [{ id: "credits", label: "Credit balance", remaining: 40, unit: "credits" }],
    },
    { providerId: "acme", displayName: ACCOUNT, status: "error" },
    { providerId: "zeta", displayName: ACCOUNT, status: "unavailable" },
  ]);
  const titles = usageItems(data).map(
    (_, index) => usageDisplay(live(data), CONNECTED, index, NOW).title,
  );

  it("shows the known windows and the Codex credits by their agreed names", () => {
    for (const title of [
      "Claude · 5h",
      "Claude · Weekly",
      "Claude · Fable Weekly",
      "Codex · Weekly",
      "Codex · Credits",
    ]) {
      assert.ok(titles.includes(title), title);
    }
  });

  it("keeps a new window under the provider name with its own short label", () => {
    assert.ok(titles.includes("Claude · Mo"));
  });

  it("names unknown, failing or unavailable providers by ID, never by account", () => {
    assert.ok(titles.includes("acme"));
    assert.ok(titles.includes("zeta"));
    for (const title of titles) {
      assert.doesNotMatch(title, /person|example|plan/i, title);
    }
    for (const provider of data.providers) {
      assert.doesNotMatch(provider.name, /person|example/);
    }
  });

  it("does not change values: Codex credits stay as reported", () => {
    const index = titles.indexOf("Codex · Credits");
    const shown = usageDisplay(live(data), CONNECTED, index, NOW);
    assert.equal(shown.value, "40 left");
    assert.equal(shown.bar, null);
  });
});
