/**
 * Assembles a release from a committed ref, in three separate folders:
 *
 * 1. `<out>/source`: the public source tree (release-files.ts), scanned;
 *    the build never runs in it.
 * 2. A build workspace in the system temp folder, outside any repository:
 *    a copy of the source, `npm ci` and the full `npm run check` (which
 *    packs the plugin). Removed afterwards.
 * 3. `<out>/publish`: only the packaged plugin and SHA256SUMS, verified.
 *
 * The packaged files are checked against the plugin inventory and against
 * the build byte for byte, and listed with their SHA-256 in
 * `<out>/package-contents.txt`. The .streamDeckPlugin archive itself is
 * not reproducible bit for bit (its ZIP metadata varies between runs);
 * compare runs by package-contents.txt, not by the archive's checksum.
 * `<out>/source-contents.txt` lists the source files with their SHA-256;
 * the source must match it after the build, and two runs compare by it.
 *
 * Limit: the package inventory (scripts/plugin/inventory.ts) is the one of
 * the checkout that runs this script, while the build is of `ref`; assemble
 * a ref with the same plugin file list, normally the checked-out commit.
 *
 *   npm run release:assemble -- [ref] [out]
 *
 * Defaults: ref HEAD, out release/assembly-<commit>. `out` must not exist
 * or be empty. Publishes nothing.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { EXPECTED_FILES, inventoryProblems, PLUGIN_DIR } from "../plugin/inventory.ts";
import {
  CHECKSUMS,
  checksumsText,
  contentManifest,
  listFiles,
  scanTree,
  sha256,
  stageSource,
  verifyChecksums,
} from "./release-files.ts";

const PACKAGE = "local.paseocontrol.e1spike.streamDeckPlugin";

function fail(message: string, problems: readonly string[] = []): never {
  throw new Error([message, ...problems.map((problem) => `  ${problem}`)].join("\n"));
}

function run(command: string, args: readonly string[], cwd: string): void {
  process.stdout.write(`\n> ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

const ref = process.argv[2] ?? "HEAD";
const short = execFileSync(
  "git",
  ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
  {
    encoding: "utf8",
  },
)
  .trim()
  .slice(0, 12);
const out = process.argv[3] ?? join("release", `assembly-${short}`);
if (existsSync(out) && readdirSync(out).length > 0) fail(`${out} is not empty; remove it first`);
const source = join(out, "source");
const publish = join(out, "publish");

const staged = stageSource(".", ref, source);
if (staged.dirty) {
  process.stderr.write(`note: uncommitted changes are not part of ${staged.commit}\n`);
}
const sourceProblems = scanTree(source, homedir());
if (sourceProblems.length > 0) fail(`${source} must not be published:`, sourceProblems);
const sourceContents = contentManifest(source);
const sourceCount = listFiles(source).length;
writeFileSync(join(out, "source-contents.txt"), sourceContents);

const build = mkdtempSync(join(tmpdir(), "paseo-control-build-"));
try {
  cpSync(source, build, { recursive: true });
  run("npm", ["ci"], build);
  run("npm", ["run", "check"], build);

  const unpacked = mkdtempSync(join(tmpdir(), "paseo-control-package-"));
  try {
    const archive = join(build, "release", PACKAGE);
    execFileSync("unzip", ["-q", archive, "-d", unpacked]);
    const top = listFiles(unpacked);
    const outside = top.filter((file) => !file.startsWith(`${PLUGIN_DIR}/`));
    if (outside.length > 0) fail(`${PACKAGE} has files outside ${PLUGIN_DIR}:`, outside);
    const files = top.map((file) => file.slice(PLUGIN_DIR.length + 1));
    const packaged = (file: string): Buffer => readFileSync(join(unpacked, PLUGIN_DIR, file));
    const problems = inventoryProblems(files, (file) => packaged(file).toString("utf8"));
    for (const file of files) {
      if (!packaged(file).equals(readFileSync(join(build, PLUGIN_DIR, file)))) {
        problems.push(`${file}: differs from the build`);
      }
    }
    if (problems.length > 0) fail(`${PACKAGE} is not the checked plugin:`, problems);
    writeFileSync(
      join(out, "package-contents.txt"),
      files.map((file) => `${sha256(packaged(file))}  ${file}\n`).join(""),
    );

    mkdirSync(publish);
    copyFileSync(archive, join(publish, PACKAGE));
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
} finally {
  rmSync(build, { recursive: true, force: true });
}

writeFileSync(join(publish, CHECKSUMS), checksumsText(publish, [PACKAGE]));
const checksumProblems = verifyChecksums(publish);
if (checksumProblems.length > 0) fail(`${publish}/${CHECKSUMS} does not verify:`, checksumProblems);
const published = listFiles(publish);
if (published.join("\n") !== [PACKAGE, CHECKSUMS].sort().join("\n")) {
  fail(`${publish} must hold only ${PACKAGE} and ${CHECKSUMS}:`, published);
}
// The build ran on a copy; the staged source must be exactly as staged.
if (contentManifest(source) !== sourceContents) fail(`${source} changed during the build`);

const archiveData = readFileSync(join(publish, PACKAGE));
process.stdout.write(
  [
    "",
    `assembled ${staged.commit}`,
    `  source:  ${source} (${String(sourceCount)} files, unchanged: ${join(out, "source-contents.txt")})`,
    `  publish: ${publish}/${PACKAGE} (${String(archiveData.length)} bytes, sha256 ${sha256(archiveData)})`,
    `           ${publish}/${CHECKSUMS} (verified)`,
    `  package: ${join(out, "package-contents.txt")} (${String(EXPECTED_FILES.length)} files)`,
    "",
  ].join("\n"),
);
