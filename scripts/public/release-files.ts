/**
 * The pieces of the public release that need no build: exporting the public
 * source tree of a committed ref, scanning a tree for files and text that
 * must not be published, and writing and verifying SHA256SUMS.
 *
 * Works the same in this repository and in the public one: the allowlist is
 * part of the public tree, and the public README overlay is taken from
 * docs/github-release/ only where a docs/ tree exists (never in public).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export const ALLOWLIST = "scripts/public/public-files.txt";
export const PLUGIN_NOTICES = "local.paseocontrol.e1spike.sdPlugin/THIRD_PARTY_NOTICES.txt";
/**
 * Only in the private repository, which has its own README.md. Joined from
 * parts (like the agent rule names below) so that this published file does
 * not match its own scan for references to internal documents.
 */
export const PRIVATE_PUBLIC_README = ["docs", "github-release", "README.md"].join("/");
export const CHECKSUMS = "SHA256SUMS";

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

/** The allowlisted paths: one per line, `#` starts a comment line. */
export function parseAllowlist(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function inRef(repo: string, commit: string, path: string): boolean {
  return git(repo, ["ls-tree", "--name-only", commit, "--", path]).trim() !== "";
}

export interface StagedSource {
  readonly commit: string;
  /** The committed files exported, without the overlays. */
  readonly files: readonly string[];
  /** Paths written on top of the export, and where each came from. */
  readonly overlays: readonly (readonly [from: string, to: string])[];
  /** The working tree had uncommitted changes; none of them are staged. */
  readonly dirty: boolean;
}

/**
 * Exports the allowlisted files of `ref` (committed content only: no
 * history, no untracked, ignored or uncommitted files) into `target`, which
 * must not exist or be empty, then writes the overlays from `ref` as well.
 */
export function stageSource(repo: string, ref: string, target: string): StagedSource {
  const commit = git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  const show = (path: string): Buffer =>
    execFileSync("git", ["-C", repo, "show", `${commit}:${path}`]);

  if (!inRef(repo, commit, ALLOWLIST)) throw new Error(`${ALLOWLIST} is not in ${commit}`);
  const paths = parseAllowlist(show(ALLOWLIST).toString("utf8"));
  const missing = paths.filter((path) => !inRef(repo, commit, path));
  if (missing.length > 0) throw new Error(`not in ${commit}: ${missing.join(", ")}`);

  // A private ref has a docs/ tree and must carry the public README there;
  // a public ref has no docs/ and its README.md is already the public one.
  const readme = inRef(repo, commit, "docs") ? PRIVATE_PUBLIC_README : "README.md";
  if (!inRef(repo, commit, readme)) throw new Error(`${readme} is not in ${commit}`);
  const overlays: (readonly [string, string])[] = [
    [readme, "README.md"],
    [PLUGIN_NOTICES, "THIRD_PARTY_NOTICES.txt"],
  ];

  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`${target} is not empty; remove it first`);
  }
  mkdirSync(target, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "paseo-control-source-"));
  try {
    const archive = join(scratch, "source.tar");
    execFileSync("git", [
      "-C",
      repo,
      "archive",
      "--format=tar",
      `--output=${archive}`,
      commit,
      "--",
      ...paths,
    ]);
    execFileSync("tar", ["-xf", archive, "-C", target]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const [from, to] of overlays) writeFileSync(join(target, to), show(from));

  const files = git(repo, ["ls-tree", "-r", "--name-only", commit, "--", ...paths])
    .split("\n")
    .filter(Boolean);
  const dirty = git(repo, ["status", "--porcelain"]).trim() !== "";
  return { commit, files, overlays, dirty };
}

/**
 * Every file below `root`, as sorted `/`-separated relative paths. Throws on
 * a symbolic link or any other entry that is neither a regular file nor a
 * directory, before anything reads or copies it: a link could pull content
 * from outside the tree into the release.
 */
export function listFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const file = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(file);
      else throw new Error(`${file}: not a regular file or directory`);
    }
  };
  walk(root);
  return found.sort();
}

/** `<sha256>  <path>` for every file below `root`, sorted by path. */
export function contentManifest(root: string): string {
  return listFiles(root)
    .map((file) => `${sha256(readFileSync(join(root, file)))}  ${file}\n`)
    .join("");
}

/** Directories that only a build, a checkout or a private workspace creates. */
const FORBIDDEN_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "release",
  ".cache",
  ".npm",
  "logs",
  "docs",
  "worktrees",
  ".claude",
  ".idea",
  ".vscode",
]);
const AGENT_RULES = ["AGENTS", "CLAUDE"].map((name) => `${name}.md`);
const FORBIDDEN_NAMES = new Set([...AGENT_RULES, ".npmrc", ".DS_Store"]);
const FORBIDDEN_SUFFIXES = [".log", ".pem", ".key", ".p12", ".pfx", ".streamDeckPlugin"];
/** Build output inside the plugin folder; the source tree never has it. */
const BUILD_OUTPUT = [
  "local.paseocontrol.e1spike.sdPlugin/bin/",
  "local.paseocontrol.e1spike.sdPlugin/ui/connection.js",
];

/** Why `path` (relative, `/`-separated) must not be published, or null. */
export function forbiddenPathReason(path: string): string | null {
  const parts = path.split("/");
  const name = parts.at(-1) ?? path;
  const directory = parts.slice(0, -1).find((part) => FORBIDDEN_DIRECTORIES.has(part));
  if (directory !== undefined) return `inside ${directory}/`;
  if (FORBIDDEN_NAMES.has(name)) return "a private or local file";
  if (name === ".env" || name.startsWith(".env.")) return "an environment file";
  const suffix = FORBIDDEN_SUFFIXES.find((ending) => name.endsWith(ending));
  if (suffix !== undefined) return `a ${suffix} file`;
  if (BUILD_OUTPUT.some((output) => path === output || path.startsWith(output))) {
    return "build output";
  }
  return null;
}

/**
 * Text that points into a private workspace. The test suite's synthetic
 * paths (/Users/someone/…) and key-shaped fixtures without a key body are
 * not matched; the scanned machine's own home directory is.
 */
export function forbiddenText(text: string, home: string): string[] {
  const found: string[] = [];
  if (home.length > 1 && text.includes(`${home}/`)) found.push("this machine's home directory");
  if (/gitlab\.com[:/]/i.test(text)) found.push("a GitLab address");
  if (/\bdocs\/[\w./-]+\.md\b/.test(text)) found.push("a reference to an internal document");
  if (/\b(?:AGENTS|CLAUDE)\.md\b/.test(text)) found.push("a reference to agent rules");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----\s*\n[A-Za-z0-9+/=]{40,}/.test(text)) {
    found.push("a private key");
  }
  return found;
}

/** Problems of the tree below `root`, one line per finding. */
export function scanTree(root: string, home: string): string[] {
  const problems: string[] = [];
  for (const file of listFiles(root)) {
    const reason = forbiddenPathReason(file);
    if (reason !== null) {
      problems.push(`${file}: ${reason}`);
      continue;
    }
    const data = readFileSync(join(root, file));
    if (data.includes(0)) continue; // binary (images)
    for (const finding of forbiddenText(data.toString("utf8"), home)) {
      problems.push(`${file}: ${finding}`);
    }
  }
  return problems;
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA256SUMS lines (`<hex>  <name>`, as `shasum -a 256` writes them). */
export function checksumsText(directory: string, names: readonly string[]): string {
  return names.map((name) => `${sha256(readFileSync(join(directory, name)))}  ${name}\n`).join("");
}

/**
 * Checks every line of `directory`/SHA256SUMS against the file it names
 * and that it names every other file there. Returns the problems.
 */
export function verifyChecksums(directory: string): string[] {
  const listed = readFileSync(join(directory, CHECKSUMS), "utf8").split("\n").filter(Boolean);
  const problems: string[] = [];
  const named = new Set<string>();
  for (const line of listed) {
    const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/.exec(line);
    if (match === null) {
      problems.push(`malformed line: ${line}`);
      continue;
    }
    const [, digest, name] = match;
    if (digest === undefined || name === undefined) continue;
    named.add(name);
    const path = join(directory, name);
    if (!existsSync(path)) problems.push(`${name}: missing`);
    else if (sha256(readFileSync(path)) !== digest) problems.push(`${name}: checksum differs`);
  }
  for (const file of listFiles(directory)) {
    if (file !== CHECKSUMS && !named.has(file)) problems.push(`${file}: not in ${CHECKSUMS}`);
  }
  return problems;
}
