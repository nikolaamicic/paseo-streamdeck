/**
 * Text primitives shared by the parsers and the Elgato UI (M6). Only steps
 * that were identical in their callers live here; limits, ellipses and
 * empty-text handling stay with each caller. key-svg.ts keeps its own
 * grapheme segmenter with the default locale: unifying it with "en" was
 * not decided.
 */

/** An unpaired UTF-16 surrogate; JSON can carry one, but it is not valid text. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, "g");

export function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text);
}

/**
 * Display text: each run of control characters (Cc) becomes one space,
 * then every lone surrogate becomes U+FFFD, then the ends are trimmed. The
 * result is always well-formed. Format characters (e.g. bidi controls,
 * zero-width space) are kept.
 */
export function cleanDisplayText(text: string): string {
  return text
    .replace(/\p{Cc}+/gu, " ")
    .replace(LONE_SURROGATES, "\uFFFD")
    .trim();
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Grapheme clusters (locale "en"), so emoji and combining marks stay whole. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}
