import { DISPLAY_STATUS_INFO, type DisplayStatus } from "../agents/display-status.ts";
import { cleanDisplayText } from "../text/display-text.ts";
import { estimateTextWidth } from "./footer-scroll.ts";
import { AMBER, GREY, RED, SILVER, WHITE } from "./ui-palette.ts";
import type { KeyFace, MessageIcon } from "./key-view.ts";

/**
 * Draws one key as an SVG (design approved by the owner 2026-11-15;
 * status palette of 2026-11-16: Error red with "!", Turn ended
 * neutral with ↩, Idle darker than Turn ended, Offline black). Limit
 * (orange triangle) and Finished (green ✓) are approved but not drawn:
 * Paseo 0.15.4 gives the plugin no reliable signal for either.
 * Coordinates are 120 × 120. All daemon-provided text is cleaned and
 * XML-escaped; the SVG references nothing external.
 *
 * Whether Stream Deck draws SVG <text> reliably is the open question this
 * one-key probe tests; the E1 package (text as native key title) is the
 * fallback.
 */

const SIZE = 120;
const PAD = 12;
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const FOOTER = SILVER;
const NEUTRAL_BG = "#1C1C1F";
/** Offline: black, unlike every status background (approved 2026-11-16). */
const OFFLINE_BG = "#000000";
const RED_BG = "#4D1C1C";
const BLUE = "#6DB3FF";
const LIGHT = "#E8E8EA";
const DIM_TITLE = "#B4B4BC";

type IconKind =
  | MessageIcon
  | "badgeQuestion"
  | "badgeLock"
  | "play"
  | "dashedRing"
  | "returnArrow"
  | "bubble"
  | "stop"
  | "diamond";

interface StatusStyle {
  readonly bg: string;
  readonly accent: string;
  readonly icon: IconKind;
  readonly dim?: boolean;
}

const STATUS_STYLE: Readonly<Record<DisplayStatus, StatusStyle>> = {
  awaiting_answer: { bg: "#4A3410", accent: AMBER, icon: "badgeQuestion" },
  awaiting_permission: { bg: "#4A3410", accent: AMBER, icon: "badgeLock" },
  error: { bg: RED_BG, accent: RED, icon: "alert" },
  running: { bg: "#17334F", accent: BLUE, icon: "play" },
  starting: { bg: "#16263A", accent: BLUE, icon: "dashedRing" },
  // Neutral ↩, no check mark: an ended turn hands work back; it is not
  // proof that the user's task is finished (spec §4).
  turn_ended: { bg: "#34343A", accent: WHITE, icon: "returnArrow" },
  // Darker than Turn ended, still clearly not the black of Offline.
  idle: { bg: "#202024", accent: LIGHT, icon: "bubble" },
  closed: { bg: "#141416", accent: "#8E8E96", icon: "stop", dim: true },
  unknown: { bg: "#26262A", accent: GREY, icon: "diamond" },
};

// Default locale, unlike display-text.ts ("en"); kept as it was (M6).
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** Removes control characters and unpaired surrogates (invalid in XML). */
export const cleanText = cleanDisplayText;

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? "");
}

function take(text: string, count: number): string {
  return graphemes(text).slice(0, count).join("");
}

/**
 * Longest title shown, in graphemes; a longer one ends in "…". Bounds the
 * scroll pass of the second line (about half a minute at most).
 */
export const TITLE_LIMIT = 80;

/** Title room before the right-edge fade (x 12 to 98), as for the footer. */
export const TITLE_VISIBLE_WIDTH = 86;

/** Title font size on the key, for width estimates. */
const TITLE_FONT_SIZE = 16;

/**
 * Two title lines. The first stays still, so it holds only what fits the
 * visible width (estimated, at most 10 graphemes), breaking at a space when
 * one keeps at least 4 graphemes on it. The second holds all the rest (within
 * TITLE_LIMIT) and scrolls when it does not fit. Only the break space is
 * dropped, so no text is lost.
 */
export function wrapTitle(text: string): string[] {
  const all = graphemes(text);
  const parts = all.length > TITLE_LIMIT ? [...all.slice(0, TITLE_LIMIT - 1), "…"] : all;
  let fit = 0;
  let used = 0;
  while (fit < Math.min(10, parts.length)) {
    const next = estimateTextWidth(parts[fit] ?? "", TITLE_FONT_SIZE);
    if (used + next > TITLE_VISIBLE_WIDTH) break;
    used += next;
    fit += 1;
  }
  // At least one grapheme, even one wider than the line.
  fit = Math.max(1, fit);
  if (fit >= parts.length) return [parts.join("")];
  let space = -1;
  for (let i = fit; i >= 4; i -= 1) {
    if (parts[i] === " ") {
      space = i;
      break;
    }
  }
  const first = space > 0 ? parts.slice(0, space) : parts.slice(0, fit);
  const rest = space > 0 ? parts.slice(space + 1) : parts.slice(fit);
  return [first.join("").trimEnd(), rest.join("").trimStart()];
}

/** The title as drawn, after cleaning; "(untitled)" when empty. */
function titleLines(face: Extract<KeyFace, { kind: "agent" }>): string[] {
  const title = cleanText(face.title ?? "");
  return wrapTitle(title === "" ? "(untitled)" : title);
}

/** Pixels the second title line must move to show its end; 0 when it fits. */
export function titleOverflow(face: KeyFace): number {
  if (face.kind !== "agent") return 0;
  const second = titleLines(face)[1];
  if (second === undefined) return 0;
  return Math.max(0, Math.ceil(estimateTextWidth(second, TITLE_FONT_SIZE) - TITLE_VISIBLE_WIDTH));
}

/** The second title line's text, for restarting its scroll; null without one. */
export function titleScrollText(face: KeyFace): string | null {
  return face.kind === "agent" ? (titleLines(face)[1] ?? null) : null;
}

function textEl(
  x: number,
  y: number,
  size: number,
  weight: number,
  fill: string,
  body: string,
  anchor = "",
): string {
  const anchorAttr = anchor === "" ? "" : ` text-anchor="${anchor}"`;
  return `<text x="${x}" y="${y}"${anchorAttr} font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}">${body}</text>`;
}

function icon(kind: IconKind, color: string, bg: string): string {
  const cx = PAD + 11;
  const cy = PAD + 11;
  const line = (width = 2) =>
    `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
  switch (kind) {
    case "badgeQuestion":
      return (
        `<circle cx="${cx}" cy="${cy}" r="11" fill="${color}"/>` +
        textEl(cx, cy + 5.6, 16, 700, bg, "?", "middle")
      );
    case "badgeLock":
      return (
        `<circle cx="${cx}" cy="${cy}" r="11" fill="${color}"/>` +
        `<rect x="${cx - 5}" y="${cy - 1}" width="10" height="7.4" rx="1.6" fill="${bg}"/>` +
        `<path d="M${cx - 2.9} ${cy - 1}v-1.9a2.9 2.9 0 0 1 5.8 0v1.9" fill="none" stroke="${bg}" stroke-width="1.9"/>`
      );
    case "alert":
      return (
        `<circle cx="${cx}" cy="${cy}" r="11" fill="${color}"/>` +
        textEl(cx, cy + 5.6, 16, 700, bg, "!", "middle")
      );
    case "play":
      return (
        `<circle cx="${cx}" cy="${cy}" r="10" ${line()}/>` +
        `<polygon points="${cx - 3},${cy - 4.8} ${cx + 5.2},${cy} ${cx - 3},${cy + 4.8}" fill="${color}" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/>`
      );
    case "dashedRing":
      return `<circle cx="${cx}" cy="${cy}" r="10" ${line()} stroke-dasharray="3.4 4.45"/><circle cx="${cx}" cy="${cy}" r="2.2" fill="${color}"/>`;
    case "returnArrow":
      return (
        `<path d="M${cx + 9} ${cy - 7}v5a5 5 0 0 1 -5 5h-12" ${line(2.3)}/>` +
        `<polyline points="${cx - 3.5},${cy - 1.5} ${cx - 8},${cy + 3} ${cx - 3.5},${cy + 7.5}" ${line(2.3)}/>`
      );
    case "bubble":
      return `<path d="M${cx - 6.6} ${cy + 7.6}A10 10 0 1 0 ${cx - 8.6} ${cy + 5.2}L${cx - 10} ${cy + 10}Z" ${line()}/>`;
    case "stop":
      return `<circle cx="${cx}" cy="${cy}" r="10" ${line()}/><rect x="${cx - 3.8}" y="${cy - 3.8}" width="7.6" height="7.6" rx="1.4" fill="${color}"/>`;
    case "diamond":
      return `<polygon points="${cx},${cy - 10} ${cx + 10},${cy} ${cx},${cy + 10} ${cx - 10},${cy}" ${line()}/>`;
    case "dots":
      return [-8, 0, 8]
        .map((dx) => `<circle cx="${cx + dx - 2}" cy="${cy}" r="2.4" fill="${color}"/>`)
        .join("");
    case "offline":
      return (
        `<circle cx="${cx}" cy="${cy}" r="10" ${line()}/>` +
        `<line x1="${cx - 7}" y1="${cy + 7}" x2="${cx + 7}" y2="${cy - 7}" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`
      );
    case "empty":
      return `<circle cx="${cx}" cy="${cy}" r="10" ${line()} stroke-dasharray="1 4.2"/>`;
  }
}

/** Right-edge fade to the background color, instead of an ellipsis. */
function fade(bg: string): string {
  return (
    `<defs><linearGradient id="fade" x1="0" x2="1" y1="0" y2="0">` +
    `<stop offset="0" stop-color="${bg}" stop-opacity="0"/><stop offset="1" stop-color="${bg}"/>` +
    `</linearGradient></defs>` +
    `<rect x="98" y="44" width="12" height="68" fill="url(#fade)"/>` +
    `<rect x="110" y="44" width="10" height="68" fill="${bg}"/>`
  );
}

/** Hides footer text that scrolled into the left margin (offset > 0 only). */
/** Hides scrolled text left of the margin in one band (y, height). */
function leftCover(bg: string, y = 88, height = 24, id = "fadeLeft"): string {
  return (
    `<defs><linearGradient id="${id}" x1="0" x2="1" y1="0" y2="0">` +
    `<stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${bg}" stop-opacity="0"/>` +
    `</linearGradient></defs>` +
    `<rect x="0" y="${y}" width="${PAD}" height="${height}" fill="${bg}"/>` +
    `<rect x="${PAD}" y="${y}" width="6" height="${height}" fill="url(#${id})"/>`
  );
}

const OPEN = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 ${SIZE} ${SIZE}">`;

/**
 * Caps for daemon text in the footer. The footer scrolls instead of being
 * cut at the key edge, so these only bound unusually long values.
 */
export const FOOTER_LIMITS = { provider: 24, project: 48, total: 80 } as const;

/**
 * The footer line of an agent key as drawn: "provider · project" (with
 * subagent and archived markers) while live, otherwise the connection word.
 * Null for message keys, which have no footer.
 */
export function footerText(face: KeyFace): string | null {
  if (face.kind !== "agent") return null;
  if (face.connection !== "live") {
    return { stale: "Stale", offline: "Offline", error: "Error" }[face.connection];
  }
  const provider = take(cleanText(face.provider), FOOTER_LIMITS.provider);
  const project = take(cleanText(face.project ?? "") || "No project", FOOTER_LIMITS.project);
  const meta = `${face.subagent ? "↳ " : ""}${face.archived ? "Archived · " : ""}${provider} · ${project}`;
  return take(meta, FOOTER_LIMITS.total);
}

function agentSvg(
  face: Extract<KeyFace, { kind: "agent" }>,
  footerOffset: number,
  titleOffset: number,
): string {
  const style = STATUS_STYLE[face.status];
  const live = face.connection === "live";
  // Offline replaces the last known status: it may no longer be true.
  const offline = face.connection === "offline";
  const bg = live ? style.bg : offline ? OFFLINE_BG : NEUTRAL_BG;
  const accent = live ? style.accent : GREY;
  const titleInk = style.dim === true || !live ? DIM_TITLE : WHITE;
  const lines = titleLines(face);
  const titleShift = Math.max(0, Math.round(titleOffset));
  const meta = footerText(face) ?? "";
  const metaFill = live ? FOOTER : face.connection === "error" ? RED : LIGHT;
  const offset = Math.max(0, Math.round(footerOffset));

  let out = `${OPEN}<rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>`;
  out += icon(offline ? "offline" : style.icon, accent, bg);
  out += textEl(
    SIZE - PAD,
    PAD + 15.5,
    13,
    500,
    offline ? LIGHT : accent,
    escapeXml(offline ? "Offline" : DISPLAY_STATUS_INFO[face.status].label),
    "end",
  );
  lines.forEach((line, index) => {
    // Only the second line scrolls; the first stays put.
    const x = index === 1 ? PAD - titleShift : PAD;
    out += textEl(x, 62 + index * 19, 16, 500, titleInk, escapeXml(line));
  });
  if (titleShift > 0) out += leftCover(bg, 67, 19, "fadeLeftTitle");
  out += textEl(PAD - offset, 103, 13, 500, metaFill, escapeXml(meta));
  if (offset > 0) out += leftCover(bg);
  out += fade(bg);
  // §6 rule 6: an agent that left the shown workspace stays, darkened.
  if (face.dimmed) out += `<rect width="${SIZE}" height="${SIZE}" fill="#000000" opacity="0.6"/>`;
  return `${out}</svg>`;
}

function messageSvg(face: Extract<KeyFace, { kind: "message" }>): string {
  const bg = face.alert ? RED_BG : face.icon === "offline" ? OFFLINE_BG : NEUTRAL_BG;
  const accent = face.alert ? RED : face.icon === "offline" ? GREY : LIGHT;
  let out = `${OPEN}<rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>`;
  out += icon(face.icon, accent, bg);
  let y = 103 - (face.lines.length - 1) * 19;
  for (const line of face.lines) {
    out += textEl(PAD, y, 16, 500, WHITE, escapeXml(line));
    y += 19;
  }
  return `${out}</svg>`;
}

/**
 * `footerOffset` and `titleOffset` move an agent key's footer and second
 * title line left by that many pixels (UI-1, W7).
 */
export function keySvg(face: KeyFace, footerOffset = 0, titleOffset = 0): string {
  return face.kind === "agent" ? agentSvg(face, footerOffset, titleOffset) : messageSvg(face);
}

/** The documented setImage form: an SVG data URL (Elgato SDK guide "Keys"). */
export function keyImageUrl(face: KeyFace, footerOffset = 0, titleOffset = 0): string {
  return `data:image/svg+xml,${encodeURIComponent(keySvg(face, footerOffset, titleOffset))}`;
}
