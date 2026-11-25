import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  classifyPackages,
  firstDifference,
  renderNotices,
  verifyPinnedText,
  type BundledPackage,
  type UpstreamPin,
} from "../../scripts/plugin/notices.ts";

const PINNED_TEXT = "Copyright (c) Upstream\n\nApache License 2.0 (synthetic test text)\n";
const PIN: UpstreamPin = {
  packages: ["@up/client", "@up/protocol"],
  version: "1.2.3",
  sha256: createHash("sha256").update(PINNED_TEXT).digest("hex"),
  provenance: ["Source: upstream repository, tag v1.2.3."],
};

function pkg(overrides: Partial<BundledPackage> & { name: string }): BundledPackage {
  return {
    version: "1.0.0",
    license: "MIT",
    licenseText: "MIT License (synthetic)",
    outputs: ["bin/plugin.js"],
    ...overrides,
  };
}

const unlicensed = { license: null, licenseText: null };

describe("third-party notices", () => {
  it("covers only the pinned packages at the pinned version with the upstream text", () => {
    const groups = classifyPackages(
      [pkg({ name: "@up/client", version: "1.2.3", ...unlicensed }), pkg({ name: "ws" })],
      PIN,
    );
    assert.deepEqual(groups.unknown, []);
    const text = renderNotices(groups, PIN, PINNED_TEXT);
    assert.match(text, /@up\/client 1\.2\.3, in bin\/plugin\.js\n=+\n\nSource: upstream/);
    assert.ok(text.includes(PINNED_TEXT.trim()));
  });

  it("refuses an unlicensed package that is not pinned, also at another version", () => {
    const groups = classifyPackages(
      [
        pkg({ name: "@up/client", version: "1.2.4", ...unlicensed }),
        pkg({ name: "left-pad", ...unlicensed }),
      ],
      PIN,
    );
    assert.deepEqual(
      groups.unknown.map((p) => `${p.name} ${p.version}`),
      ["@up/client 1.2.4", "left-pad 1.0.0"],
    );
    assert.throws(
      () => renderNotices(groups, PIN, PINNED_TEXT),
      /no license text: @up\/client 1\.2\.4, left-pad 1\.0\.0/,
    );
  });

  it("refuses a license field without a license file to reproduce", () => {
    const groups = classifyPackages(
      [
        pkg({ name: "metadata-mit", licenseText: null }),
        pkg({ name: "proprietary", license: "UNLICENSED", licenseText: null }),
        pkg({ name: "see-file", license: "SEE LICENSE IN terms.txt", licenseText: null }),
        // A license field also takes a pinned package out of the pin.
        pkg({ name: "@up/client", version: "1.2.3", license: "Apache-2.0", licenseText: null }),
      ],
      PIN,
    );
    assert.deepEqual(groups.pinned, []);
    assert.deepEqual(
      groups.unknown.map((p) => p.name),
      ["@up/client", "metadata-mit", "proprietary", "see-file"],
    );
    assert.throws(() => renderNotices(groups, PIN, PINNED_TEXT), /no license text: @up\/client/);
  });

  it("does not apply the pin to a pinned package that ships its own license", () => {
    const groups = classifyPackages([pkg({ name: "@up/client", version: "1.2.3" })], PIN);
    assert.equal(groups.pinned.length, 0);
    assert.equal(groups.licensed.length, 1);
  });

  it("rejects a changed upstream text", () => {
    assert.doesNotThrow(() => {
      verifyPinnedText(PINNED_TEXT, PIN, "upstream");
    });
    assert.throws(() => {
      verifyPinnedText(PINNED_TEXT.replace("2.0", "2.1"), PIN, "upstream");
    }, /upstream changed/);
  });

  it("produces the same text whatever order the packages arrive in", () => {
    const packages = [pkg({ name: "zod" }), pkg({ name: "@elgato/utils" }), pkg({ name: "ws" })];
    const forward = renderNotices(classifyPackages(packages, PIN), PIN, PINNED_TEXT);
    const reverse = renderNotices(classifyPackages([...packages].reverse(), PIN), PIN, PINNED_TEXT);
    assert.equal(forward, reverse);
    assert.ok(forward.indexOf("@elgato/utils") < forward.indexOf("ws 1.0.0"));
  });

  it("reports the first line where a committed file is out of date", () => {
    assert.equal(firstDifference("a\nb\n", "a\nb\n"), null);
    assert.deepEqual(firstDifference("a\nws 8.22.0\n", "a\nws 8.23.0\n"), {
      line: 2,
      committed: "ws 8.22.0",
      generated: "ws 8.23.0",
    });
    // A file that only lacks the final newline, or has CRLF endings, is out of date too.
    assert.equal(firstDifference("a\nb", "a\nb\n")?.line, 3);
    assert.equal(firstDifference("a\r\nb\r\n", "a\nb\n")?.line, 1);
  });
});
