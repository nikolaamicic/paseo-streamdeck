import assert from "node:assert/strict";
import { estimateTextWidth } from "../../src/spike/footer-scroll.ts";
import { describe, it } from "node:test";
import { DISPLAY_STATUS_INFO, type DisplayStatus } from "../../src/agents/display-status.ts";
import {
  cleanText,
  escapeXml,
  FOOTER_LIMITS,
  footerText,
  keyImageUrl,
  keySvg,
  TITLE_LIMIT,
  TITLE_VISIBLE_WIDTH,
  titleOverflow,
  wrapTitle,
} from "../../src/spike/key-svg.ts";
import type { KeyFace } from "../../src/spike/key-view.ts";

const STATUSES = Object.keys(DISPLAY_STATUS_INFO).filter(
  (key): key is DisplayStatus => key in DISPLAY_STATUS_INFO,
);

function agent(overrides: Partial<Extract<KeyFace, { kind: "agent" }>> = {}): KeyFace {
  return {
    kind: "agent",
    status: "running",
    title: "Refactor login flow",
    provider: "claude",
    project: "paseo-web",
    subagent: false,
    archived: false,
    connection: "live",
    dimmed: false,
    ...overrides,
  };
}

const MESSAGE: KeyFace = {
  kind: "message",
  icon: "alert",
  lines: ["Paseo", "error", "auth"],
  alert: true,
};

/** Text content of every <text> element, still XML-escaped. */
function texts(svg: string): string[] {
  return Array.from(svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g), (match) => match[1] ?? "");
}

function numbers(svg: string, attribute: string): number[] {
  return Array.from(svg.matchAll(new RegExp(` ${attribute}="([-\\d.]+)"`, "g")), (match) =>
    Number(match[1]),
  );
}

function allFaces(): KeyFace[] {
  return [
    ...STATUSES.flatMap((status) =>
      (["live", "stale", "offline", "error"] as const).map((connection) =>
        agent({ status, connection }),
      ),
    ),
    ...(["dots", "offline", "alert", "empty"] as const).flatMap((icon) =>
      [true, false].map((alert): KeyFace => ({ kind: "message", icon, lines: ["Paseo"], alert })),
    ),
  ];
}

/** WCAG 2 contrast ratio of two #RRGGBB colors. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r = 0, g = 0, bl = 0] = [1, 3, 5].map((start) => {
      const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe("keySvg", () => {
  it("draws Running in the approved blue and an ended turn without success green or check", () => {
    const running = keySvg(agent({ status: "running" }));
    assert.match(running, /fill="#17334F"/);
    assert.match(running, /fill="#6DB3FF"[^>]*>Running</);
    const ended = keySvg(agent({ status: "turn_ended" }));
    assert.match(ended, />Turn ended</);
    assert.doesNotMatch(ended, /#1E4630|#4CD787|Finished/);
  });

  it("draws the approved status cues: Error red !, Turn ended neutral ↩, Idle darker", () => {
    const error = keySvg(agent({ status: "error" }));
    assert.match(error, /fill="#4D1C1C"/);
    assert.match(error, /<circle [^>]*fill="#FF7B6B"\/><text [^>]*>!</, "a round ! badge");
    assert.doesNotMatch(error, /<polygon/, "the triangle is kept for Limit");
    const ended = keySvg(agent({ status: "turn_ended" }));
    assert.match(ended, /<polyline points="/, "the ↩ arrow head");
    const background = (svg: string) =>
      /<rect width="120" height="120" fill="(#[0-9A-F]{6})"/.exec(svg)?.[1] ?? "";
    const idle = background(keySvg(agent({ status: "idle" })));
    const endedBg = background(ended);
    assert.ok(contrast(idle, "#000000") < contrast(endedBg, "#000000"), "Idle darker");
    assert.notEqual(idle, "#000000", "Idle is not Offline black");
  });

  it("never draws success green, a check mark or Finished for any status", () => {
    for (const status of STATUSES) {
      const svg = keySvg(agent({ status }));
      assert.doesNotMatch(svg, /#1E4630|#4CD787|Finished|✓/, status);
    }
  });

  it("shows status word, two title lines and the provider/project footer", () => {
    assert.deepEqual(texts(keySvg(agent())), [
      "Running",
      "Refactor",
      "login flow",
      "claude · paseo-web",
    ]);
  });

  it("keeps a distinct background and English label for every status", () => {
    const backgrounds = new Set<string>();
    for (const status of STATUSES) {
      const svg = keySvg(agent({ status }));
      assert.ok(texts(svg).includes(DISPLAY_STATUS_INFO[status].label), status);
      const background = /<rect width="120" height="120" fill="([^"]+)"/.exec(svg)?.[1];
      assert.ok(background !== undefined, status);
      backgrounds.add(`${background}|${DISPLAY_STATUS_INFO[status].label}`);
    }
    assert.equal(backgrounds.size, STATUSES.length);
  });

  it("marks subagents, archived agents and missing title/project", () => {
    const svg = keySvg(agent({ title: null, project: null, subagent: true, archived: true }));
    const shown = texts(svg);
    assert.equal(shown[1], "(untitled)");
    assert.equal(shown.at(-1), "↳ Archived · claude · No project");
  });

  it("replaces the footer and dims the key when data is not live", () => {
    for (const [connection, word, background] of [
      ["stale", "Stale", "#1C1C1F"],
      ["offline", "Offline", "#000000"],
      ["error", "Error", "#1C1C1F"],
    ] as const) {
      const svg = keySvg(agent({ connection }));
      assert.equal(texts(svg).at(-1), word);
      assert.match(svg, new RegExp(`<rect width="120" height="120" fill="${background}"`));
      assert.doesNotMatch(svg, /#6DB3FF/, "status color must not suggest live data");
    }
  });

  it("draws Offline black with the disconnected icon instead of the last status", () => {
    for (const status of STATUSES) {
      const svg = keySvg(agent({ status, connection: "offline" }));
      assert.equal(texts(svg)[0], "Offline", status);
      assert.match(svg, /<line x1=/, "the crossed-out ring of the offline icon");
    }
    const notConnected = keySvg({
      kind: "message",
      icon: "offline",
      lines: ["Paseo", "not", "connected"],
      alert: false,
    });
    assert.match(notConnected, /<rect width="120" height="120" fill="#000000"/);
  });

  it("escapes markup in daemon text so it cannot change the SVG", () => {
    const hostile = `</text><script>alert(1)</script><image href="https://x/y"/> & "q" 'a'`;
    const svg = keySvg(agent({ title: hostile, provider: hostile, project: hostile }));
    // Outside text content there is no injected element or attribute; inside
    // it the hostile text is only escaped characters.
    const markup = svg.replace(/(<text [^>]*>)[^<]*(<\/text>)/g, "$1$2");
    assert.doesNotMatch(markup, /<script|<image|href=|https:/);
    assert.ok(texts(svg).some((text) => text.includes("&lt;image href=&quot;")));
    assert.equal(texts(svg).length, 4);
    for (const text of texts(svg)) assert.doesNotMatch(text, /[<>"']|&(?!amp;|lt;|gt;|quot;|#39;)/);
    assert.equal(escapeXml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  it("produces well-formed elements without repeated attributes", () => {
    const faces: KeyFace[] = [
      ...STATUSES.map((status) => agent({ status })),
      ...(["dots", "offline", "alert", "empty"] as const).map((icon): KeyFace => ({
        kind: "message",
        icon,
        lines: ["Paseo"],
        alert: false,
      })),
    ];
    for (const face of faces) {
      for (const [tag] of keySvg(face).matchAll(/<[a-zA-Z][^>]*>/g)) {
        const names = Array.from(tag.matchAll(/ ([\w:-]+)="/g), (match) => match[1]);
        assert.equal(new Set(names).size, names.length, tag);
      }
    }
  });

  it("uses only solid hex colors, no CSS color functions", () => {
    for (const face of allFaces()) {
      const svg = keySvg(face);
      assert.doesNotMatch(svg, /rgba?\(|hsla?\(/);
      for (const [, value] of svg.matchAll(/(?:fill|stroke|stop-color)="([^"]*)"/g)) {
        assert.match(value ?? "", /^(#[0-9A-F]{6}|none|url\(#fade\))$/, value);
      }
    }
  });

  it("keeps key text readable against the key background", () => {
    for (const face of allFaces()) {
      const svg = keySvg(face);
      const background = /<rect width="120" height="120" fill="(#[0-9A-F]{6})"/.exec(svg)?.[1];
      assert.ok(background !== undefined);
      // Text centered on an icon badge sits on the badge color, not the key.
      for (const [tag] of svg.matchAll(/<text (?![^>]*text-anchor="middle")[^>]*>/g)) {
        const fill = /fill="(#[0-9A-F]{6})"/.exec(tag)?.[1];
        assert.ok(fill !== undefined, tag);
        const ratio = contrast(fill, background);
        assert.ok(ratio >= 4.5, `${fill} on ${background}: ${ratio.toFixed(2)}`);
      }
    }
  });

  it("references nothing outside the SVG", () => {
    for (const face of [agent(), MESSAGE]) {
      const svg = keySvg(face);
      assert.deepEqual(svg.match(/https?:\/\/[^"]*/g), ["http://www.w3.org/2000/svg"]);
      assert.doesNotMatch(svg, /href|<script|<style|<image|<foreignObject|@import/i);
      assert.deepEqual(
        svg.match(/url\([^)]*\)/g) ?? [],
        face.kind === "agent" ? ["url(#fade)"] : [],
      );
    }
  });

  it("removes control characters and unpaired surrogates before drawing", () => {
    assert.equal(cleanText("a\u0000b\u001b[2J\nc\u007f"), "a b [2J c");
    assert.equal(cleanText("x\uD800y\uDC00z"), "x�y�z");
    assert.equal(cleanText("ok 👍🏽"), "ok 👍🏽");
    // An unpaired surrogate would make encodeURIComponent throw.
    const url = keyImageUrl(agent({ title: "bad\uD800\u0007title" }));
    assert.ok(url.startsWith("data:image/svg+xml,%3Csvg"));
    assert.doesNotMatch(decodeURIComponent(url), /\p{Cc}/u);
  });

  it("keeps all coordinates inside the 120 × 120 key", () => {
    const long = "x".repeat(300);
    const faces: KeyFace[] = [
      ...STATUSES.map((status) => agent({ status, title: long, project: long })),
      agent({ connection: "offline" }),
      MESSAGE,
      { kind: "message", icon: "dots", lines: ["Paseo", "connecting"], alert: false },
      { kind: "message", icon: "offline", lines: ["Paseo", "not", "connected"], alert: false },
      { kind: "message", icon: "empty", lines: ["Agent", "not found"], alert: false },
    ];
    for (const face of faces) {
      const svg = keySvg(face);
      assert.match(svg, /viewBox="0 0 120 120"/);
      for (const attribute of ["x", "y", "cx", "cy", "x1", "y1", "x2", "y2"]) {
        for (const value of numbers(svg, attribute)) {
          assert.ok(value >= 0 && value <= 120, `${attribute}=${String(value)}`);
        }
      }
      assert.ok(texts(svg).length <= 5);
    }
  });

  it("keeps the full title and footer text up to the documented caps", () => {
    const shown = texts(keySvg(agent({ title: "y".repeat(90), project: "z".repeat(80) })));
    assert.equal(`${shown[1] ?? ""}${shown[2] ?? ""}`, `${"y".repeat(TITLE_LIMIT - 1)}…`);
    assert.deepEqual(shown.slice(3), [`claude · ${"z".repeat(FOOTER_LIMITS.project)}`]);
    const capped = footerText(agent({ provider: "p".repeat(40), project: "q".repeat(60) }));
    assert.equal(
      capped,
      `${"p".repeat(FOOTER_LIMITS.provider)} · ${"q".repeat(FOOTER_LIMITS.project)}`,
    );
    const all = footerText(
      agent({ subagent: true, archived: true, provider: "p".repeat(40), project: "q".repeat(60) }),
    );
    const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" }).segment(all ?? "");
    assert.equal(Array.from(graphemes).length, FOOTER_LIMITS.total);
  });

  it("moves only the footer by the scroll offset and covers the left margin while scrolled", () => {
    const face = agent({ project: "a-long-project-name-that-scrolls" });
    const still = keySvg(face);
    assert.match(still, /<text x="12" y="103"/);
    assert.doesNotMatch(still, /fadeLeft/);
    const moved = keySvg(face, 40);
    assert.match(moved, /<text x="-28" y="103"/);
    assert.match(moved, /<rect x="0" y="88" width="12" height="24" fill="#17334F"\/>/);
    assert.deepEqual(moved.match(/url\([^)]*\)/g), ["url(#fadeLeft)", "url(#fade)"]);
    assert.deepEqual(
      texts(moved).slice(0, 3),
      texts(still).slice(0, 3),
      "status and title do not move",
    );
    for (const [tag] of moved.matchAll(/<[a-zA-Z][^>]*>/g)) {
      const names = Array.from(tag.matchAll(/ ([\w:-]+)="/g), (match) => match[1]);
      assert.equal(new Set(names).size, names.length, tag);
    }
    assert.doesNotMatch(moved, /rgba?\(|hsla?\(/);
  });

  it("has no footer for message keys and only the connection word when not live", () => {
    assert.equal(footerText(MESSAGE), null);
    assert.equal(footerText(agent({ connection: "offline" })), "Offline");
    assert.equal(footerText(agent({ connection: "stale" })), "Stale");
    assert.equal(footerText(agent({ connection: "error" })), "Error");
  });
});

describe("title scrolling", () => {
  it("lets a long second title line scroll and keeps short titles still", () => {
    assert.equal(titleOverflow(agent({ title: "Fix tests" })), 0);
    assert.equal(titleOverflow(agent({ title: "Refactor login flow" })), 0);
    const long = agent({ title: "Refactor the login flow and the session expiry handling" });
    const overflow = titleOverflow(long);
    assert.ok(overflow > 0);
    const moved = keySvg(long, 0, overflow);
    assert.match(moved, new RegExp(`x="${12 - overflow}"[^>]*>the login flow`));
    assert.match(moved, /fadeLeftTitle/, "text left of the margin is covered");
    assert.match(keySvg(long), /x="12"[^>]*>Refactor</, "the first line stays put");
    assert.equal(titleOverflow({ kind: "message", icon: "dots", lines: [], alert: false }), 0);
  });
});

describe("wrapTitle", () => {
  it("keeps the whole rest of the title on the second line, up to the limit", () => {
    const words = Array.from({ length: 30 }, (_, index) => `w${index}`).join(" ");
    const [first, second] = wrapTitle(words);
    assert.equal(first, "w0 w1 w2");
    assert.ok(second?.startsWith("w3 w4"));
    const graphemeCount = Array.from(
      new Intl.Segmenter("en", { granularity: "grapheme" }).segment(`${first} ${second}`),
    ).length;
    assert.equal(graphemeCount, TITLE_LIMIT, "capped");
    assert.ok(second?.endsWith("…"), "a cut title says so");
    assert.equal(wrapTitle("Refactor login flow").join(" "), "Refactor login flow", "short: whole");
  });

  it("keeps short titles on one line", () => {
    assert.deepEqual(wrapTitle("Fix tests"), ["Fix tests"]);
  });

  it("breaks at the last space within the first line", () => {
    assert.deepEqual(wrapTitle("Refactor login flow"), ["Refactor", "login flow"]);
    assert.deepEqual(wrapTitle("Add retry to the upload worker"), [
      "Add retry",
      "to the upload worker",
    ]);
  });

  /** The first line fits; together the lines hold the whole title. */
  function assertWrapped(text: string): string[] {
    const lines = wrapTitle(text);
    const [first = "", second] = lines;
    assert.ok(
      estimateTextWidth(first, 16) <= TITLE_VISIBLE_WIDTH ||
        [...new Intl.Segmenter().segment(first)].length === 1,
      `fits: ${first}`,
    );
    const joined = second === undefined ? first : [first + second, `${first} ${second}`];
    assert.ok(
      typeof joined === "string" ? joined === text : joined.includes(text),
      `no text lost: ${text}`,
    );
    return lines;
  }

  it("breaks by width so the still first line fits, and loses no text", () => {
    assert.deepEqual(assertWrapped("WWWWWWWWWW rest")[1]?.endsWith("rest"), true);
    assert.equal(assertWrapped("WWWWWWWW").length, 2, "a too wide single line gets a second line");
    assertWrapped("工作空间项目测试名称 rest");
    assertWrapped("Internationalization");
    // Synthetic: Latin with diacritics and an emoji with a skin tone modifier.
    assertWrapped("ćevapčići-na-žaru-👍🏽");
    assertWrapped("👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽");
    assert.deepEqual(wrapTitle("Fix tests"), ["Fix tests"], "a short title stays one line");
  });
});
