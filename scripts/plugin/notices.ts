import { createHash } from "node:crypto";

/**
 * The pure part of scripts/plugin/third-party-notices.mjs: which bundled
 * packages may be listed and how, the notices text, and the comparison with
 * the committed file. Collecting the packages (rollup, node_modules) stays
 * in the script. This records what the packages and their source state; it
 * is not a legal review.
 */

export interface BundledPackage {
  readonly name: string;
  readonly version: string;
  /** The package.json `license` field, if it is a string. */
  readonly license: string | null;
  /** The text of the package's own license file, line endings normalized. */
  readonly licenseText: string | null;
  /** The plugin files the package is bundled into. */
  readonly outputs: readonly string[];
}

/**
 * A license text taken from a package's source repository for exactly
 * these packages at exactly this version, used only while they ship no
 * license of their own. `sha256` pins the stored text.
 */
export interface UpstreamPin {
  readonly packages: readonly string[];
  readonly version: string;
  readonly sha256: string;
  readonly provenance: readonly string[];
}

export interface PackageGroups {
  /** Ship their own license file. */
  readonly licensed: readonly BundledPackage[];
  /** Ship no license; covered by the pinned upstream text. */
  readonly pinned: readonly BundledPackage[];
  /**
   * No license text to reproduce and not pinned: must not be shipped. This
   * includes a package.json `license` field without a license file (e.g.
   * "MIT", "UNLICENSED", "SEE LICENSE IN <file>"): a field alone does not
   * carry the copyright and permission notice that has to go with copies.
   */
  readonly unknown: readonly BundledPackage[];
}

// Code-point order, independent of the machine's locale, so local and CI
// runs produce the same file.
function byNameThenVersion(a: BundledPackage, b: BundledPackage): number {
  const key = (p: BundledPackage): string => `${p.name}\u0000${p.version}`;
  const [left, right] = [key(a), key(b)];
  return left < right ? -1 : left > right ? 1 : 0;
}

export function classifyPackages(
  packages: readonly BundledPackage[],
  pin: UpstreamPin,
): PackageGroups {
  const sorted = [...packages].sort(byNameThenVersion);
  const isPinned = (p: BundledPackage): boolean =>
    p.licenseText === null &&
    p.license === null &&
    pin.packages.includes(p.name) &&
    p.version === pin.version;
  return {
    licensed: sorted.filter((p) => p.licenseText !== null),
    pinned: sorted.filter(isPinned),
    unknown: sorted.filter((p) => p.licenseText === null && !isPinned(p)),
  };
}

/** Throws unless the stored upstream text is exactly the pinned one. */
export function verifyPinnedText(text: string, pin: UpstreamPin, label: string): void {
  const digest = createHash("sha256").update(text).digest("hex");
  if (digest !== pin.sha256) throw new Error(`${label} changed (sha256 ${digest})`);
}

const RULE = "=".repeat(78);

/**
 * The notices file. Refuses packages without a license text instead of
 * listing them: such a package must not be shipped until its license is
 * established and, if needed, pinned. A license file being present is not
 * a judgement of its terms or their compatibility.
 */
export function renderNotices(groups: PackageGroups, pin: UpstreamPin, pinnedText: string): string {
  if (groups.unknown.length > 0) {
    throw new Error(`no license text: ${groups.unknown.map(label).join(", ")}`);
  }
  const lines = [
    "Third-party software in this plugin",
    "",
    "The plugin bundles the following npm packages into the listed files. Each",
    "package's own license text follows.",
    "",
  ];
  for (const p of groups.licensed) {
    lines.push(
      RULE,
      `${label(p)} (${p.license ?? "see license text"}), in ${p.outputs.join(", ")}`,
      RULE,
      "",
      p.licenseText ?? "",
      "",
    );
  }
  if (groups.pinned.length > 0) {
    const outputs = [...new Set(groups.pinned.flatMap((p) => p.outputs))];
    lines.push(
      RULE,
      `${groups.pinned.map(label).join(", ")}, in ${outputs.join(", ")}`,
      RULE,
      "",
      ...pin.provenance,
      "",
      pinnedText.trim(),
      "",
    );
  }
  return lines.join("\n");
}

function label(p: BundledPackage): string {
  return `${p.name} ${p.version}`;
}

export interface Difference {
  /** 1-based line number of the first differing line. */
  readonly line: number;
  readonly committed: string | undefined;
  readonly generated: string | undefined;
}

/** The first line where the committed file and the generated text differ. */
export function firstDifference(committed: string, generated: string): Difference | null {
  if (committed === generated) return null;
  const left = committed.split("\n");
  const right = generated.split("\n");
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return { line: index + 1, committed: left[index], generated: right[index] };
}
