/**
 * Writes or checks the third-party notices of the packaged plugin: every npm
 * package that rollup actually bundles (the same inputs and resolution as
 * rollup.config.mjs), with the license text each package ships. Run after
 * `npm run build`, from the repository root:
 *
 *   node scripts/plugin/third-party-notices.mjs > THIRD_PARTY_NOTICES.txt
 *   node scripts/plugin/third-party-notices.mjs --check [file]
 *
 * `--check` compares the generated text byte for byte with the committed
 * file (default NOTICES_FILE) and fails if it is out of date. Both modes
 * fail, without printing notices, if a bundled package ships no license
 * file (a package.json license field alone is not enough) and is not
 * covered by the pinned upstream text below.
 *
 * One explicit, versioned supplement (UPSTREAM below): the Paseo client
 * packages 0.15.4 ship no license, so the LICENSE file of the Paseo source
 * repository at the matching tag is added for them, with its provenance.
 * That text comes from the source repository, not from the npm packages.
 *
 * Text and rules live in notices.ts. This records what the packages and
 * their source state; it is not a legal review. Plain JavaScript like
 * rollup.config.mjs: the rollup plugins' default exports do not typecheck
 * under NodeNext.
 */
import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rollup } from "rollup";
import { classifyPackages, firstDifference, renderNotices, verifyPinnedText } from "./notices.ts";

const NOTICES_FILE = "local.paseocontrol.e1spike.sdPlugin/THIRD_PARTY_NOTICES.txt";
const USAGE = "usage: node scripts/plugin/third-party-notices.mjs [--check [file]]";

/**
 * Applies only to exactly these packages at exactly this version, and only
 * while they ship no license themselves. The stored file is checked against
 * its SHA-256 on every run.
 */
const UPSTREAM_FILE = "scripts/plugin/upstream-licenses/paseo-v0.15.4-LICENSE.txt";
const UPSTREAM = {
  packages: ["@getpaseo/client", "@getpaseo/protocol", "@getpaseo/relay"],
  version: "0.15.4",
  sha256: "79d5aedce6aa0adc547336dc1bd34c5cc9308ba110fac7079ed97515ee573ad3",
  provenance: [
    "Source: https://github.com/getpaseo/paseo, file LICENSE at tag v0.15.4",
    "(commit 1c00b365c9e0b74c1580eba33d905d693125ae21), retrieved 2026-11-25.",
    "The npm packages contain neither a license file nor a license field, nor",
    "a repository or source commit reference; this text is taken from the",
    "Paseo source repository at the matching version tag, not from the npm",
    "packages.",
  ],
};

const BUNDLES = [
  {
    output: "bin/plugin.js",
    input: "dist/spike/plugin.js",
    plugins: [
      nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
      commonjs(),
    ],
  },
  {
    output: "ui/connection.js",
    input: "dist/inspector/page/entry.js",
    plugins: [nodeResolve({ browser: true, preferBuiltins: false })],
  },
];

const MARKER = "node_modules/";

function packageDirectory(moduleId) {
  const id = moduleId.replace(/^\0/, "");
  const at = id.lastIndexOf(MARKER);
  if (at < 0) return null;
  const parts = id.slice(at + MARKER.length).split("/");
  const first = parts[0] ?? "";
  const name = first.startsWith("@") ? `${first}/${parts[1] ?? ""}` : first;
  return id.slice(0, at + MARKER.length) + name;
}

function readPackage(directory) {
  const meta = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const field = (key) =>
    typeof meta === "object" && meta !== null ? Reflect.get(meta, key) : undefined;
  const name = field("name");
  const version = field("version");
  const license = field("license");
  const file = readdirSync(directory).find((entry) => /^(licen[cs]e|copying)/i.test(entry));
  return {
    name: typeof name === "string" ? name : directory,
    version: typeof version === "string" ? version : "unknown",
    license: typeof license === "string" ? license : null,
    // Line endings only are normalized (some packages ship CRLF); the text is unchanged.
    licenseText:
      file === undefined
        ? null
        : readFileSync(join(directory, file), "utf8").replace(/\r\n?/g, "\n").trim(),
  };
}

async function bundledPackages(bundle) {
  const built = await rollup({
    input: bundle.input,
    plugins: [...bundle.plugins],
    // Warnings go to stderr, so they stay visible without entering the output.
    onwarn: (warning) => {
      process.stderr.write(`rollup: ${warning.message}\n`);
    },
  });
  const found = new Map();
  try {
    for (const module of built.cache?.modules ?? []) {
      const directory = packageDirectory(module.id);
      if (directory !== null && !found.has(directory)) found.set(directory, readPackage(directory));
    }
  } finally {
    await built.close();
  }
  return found;
}

async function collectPackages() {
  const all = new Map();
  for (const bundle of BUNDLES) {
    for (const [directory, info] of await bundledPackages(bundle)) {
      const entry = all.get(directory) ?? { ...info, outputs: [] };
      entry.outputs.push(bundle.output);
      all.set(directory, entry);
    }
  }
  return [...all.values()];
}

function fail(message) {
  process.stderr.write(`third-party-notices: ${message}\n`);
  process.exitCode = 1;
}

async function main(args) {
  const check = args[0] === "--check";
  if ((args.length > 0 && !check) || args.length > 2) {
    fail(USAGE);
    return;
  }
  const groups = classifyPackages(await collectPackages(), UPSTREAM);
  if (groups.unknown.length > 0) {
    fail("FAILED, bundled packages without a license file:");
    for (const p of groups.unknown) {
      const field =
        p.license === null ? "no license field" : `license field ${JSON.stringify(p.license)}`;
      process.stderr.write(`- ${p.name} ${p.version} (${field})\n`);
    }
    return;
  }
  let pinnedText = "";
  if (groups.pinned.length > 0) {
    pinnedText = readFileSync(UPSTREAM_FILE, "utf8");
    verifyPinnedText(pinnedText, UPSTREAM, UPSTREAM_FILE);
  }
  const text = renderNotices(groups, UPSTREAM, pinnedText);
  if (!check) {
    process.stdout.write(text);
    return;
  }
  const file = args[1] ?? NOTICES_FILE;
  const difference = firstDifference(readFileSync(file, "utf8"), text);
  if (difference === null) {
    process.stdout.write(`third-party-notices: ${file} is up to date\n`);
    return;
  }
  fail(`FAILED, ${file} is out of date (first difference at line ${String(difference.line)})`);
  process.stderr.write(`  committed: ${JSON.stringify(difference.committed ?? null)}\n`);
  process.stderr.write(`  generated: ${JSON.stringify(difference.generated ?? null)}\n`);
  process.stderr.write(`Regenerate it: node scripts/plugin/third-party-notices.mjs > ${file}\n`);
}

await main(process.argv.slice(2));
