import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRIP_TEXT_LIMIT, stripLine } from "../../src/spike/strip-scroll.ts";
import { cleanDisplayText, graphemes, hasLoneSurrogate } from "../../src/text/display-text.ts";

const FAMILY = "👨‍👩‍👧‍👦";
const ACCENTED = "é";
const FLAG = "🇷🇸";

describe("graphemes", () => {
  it("keeps ZWJ sequences, combining marks and flags whole", () => {
    assert.deepEqual(graphemes(`${FAMILY}${ACCENTED}${FLAG}a`), [FAMILY, ACCENTED, FLAG, "a"]);
    assert.deepEqual(graphemes(""), []);
  });
});

describe("hasLoneSurrogate", () => {
  it("finds unpaired high and low surrogates, not valid pairs", () => {
    for (const text of ["\uD800", "x\uDC00", "\uDC00\uD800"]) {
      assert.equal(hasLoneSurrogate(text), true, JSON.stringify(text));
    }
    for (const text of ["", "plain", "􏿿", FAMILY]) {
      assert.equal(hasLoneSurrogate(text), false, JSON.stringify(text));
    }
  });
});

describe("cleanDisplayText", () => {
  it("turns each run of control characters into one space, then trims", () => {
    assert.equal(cleanDisplayText("a\t\tb\n\nc"), "a b c");
    assert.equal(cleanDisplayText("\u0000start\u001bend\u007f"), "start end");
    assert.equal(cleanDisplayText("x\r\ny"), "x y");
  });

  it("replaces every lone surrogate with U+FFFD and keeps valid pairs", () => {
    assert.equal(cleanDisplayText("a\uD800b\uDC00c"), "a�b�c");
    assert.equal(cleanDisplayText("\uDC00\uD800"), "��");
    assert.equal(cleanDisplayText("􏿿"), "􏿿");
  });

  it("keeps format characters and other spaces inside the text", () => {
    assert.equal(cleanDisplayText("‮bidi‬"), "‮bidi‬");
    assert.equal(cleanDisplayText("zw​sp"), "zw​sp");
    assert.equal(cleanDisplayText("nb sp"), "nb sp");
    assert.equal(cleanDisplayText(` ${FAMILY} `), FAMILY);
  });
});

describe("stripLine limit with multi-code-point graphemes", () => {
  it("counts graphemes, not code units, at the exact limit", () => {
    for (const unit of [ACCENTED, FAMILY, FLAG]) {
      const atLimit = unit.repeat(STRIP_TEXT_LIMIT);
      assert.equal(stripLine(atLimit), atLimit, "at the limit: unchanged");
      const over = stripLine(unit.repeat(STRIP_TEXT_LIMIT + 1));
      assert.equal(over, `${unit.repeat(STRIP_TEXT_LIMIT - 1)}…`, "over: cut with an ellipsis");
    }
  });
});
