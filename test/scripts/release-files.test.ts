import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  ALLOWLIST,
  CHECKSUMS,
  checksumsText,
  contentManifest,
  forbiddenPathReason,
  forbiddenText,
  listFiles,
  parseAllowlist,
  PLUGIN_NOTICES,
  PRIVATE_PUBLIC_README,
  scanTree,
  stageSource,
  verifyChecksums,
} from "../../scripts/public/release-files.ts";

const scratch = mkdtempSync(join(tmpdir(), "paseo-control-release-test-"));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});
let made = 0;
function freshDir(): string {
  made += 1;
  return join(scratch, String(made));
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

/** A throwaway repository; its commits use a fixed test identity. */
function repoWith(files: Record<string, string>): string {
  const repo = freshDir();
  mkdirSync(repo);
  git(repo, ["-c", "init.defaultBranch=main", "init", "-q"]);
  commit(repo, files);
  return repo;
}

function commit(repo: string, files: Record<string, string>): string {
  write(repo, files);
  git(repo, ["add", "-A"]);
  git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "test",
  ]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

/**
 * This file is part of the public tree and scanned with it, so the samples
 * that the scan must reject are assembled from parts.
 */
const MD = ".md";
const GITLAB = ["gitlab", "com"].join(".");

const PUBLIC_README = "# Public README\n";
const NOTICES = "Third-party software\n";
const PRIVATE = {
  [ALLOWLIST]: "# comment\nsrc\nLICENSE\nlocal.paseocontrol.e1spike.sdPlugin\n",
  "README.md": "# Private README\n",
  [PRIVATE_PUBLIC_README]: PUBLIC_README,
  [`docs/internal${MD}`]: "internal\n",
  LICENSE: "MIT\n",
  "src/a.ts": "export const a = 1;\n",
  [PLUGIN_NOTICES]: NOTICES,
};

describe("parseAllowlist", () => {
  it("keeps one path per line and drops comments and blank lines", () => {
    assert.deepEqual(parseAllowlist("# c\n\n src \nLICENSE\n  # d\n"), ["src", "LICENSE"]);
  });
});

describe("stageSource", () => {
  it("exports only allowlisted committed files and the overlays, never uncommitted work", () => {
    const repo = repoWith(PRIVATE);
    write(repo, {
      "src/a.ts": "export const a = 2; // uncommitted\n",
      "src/new.ts": "untracked\n",
    });
    const target = freshDir();
    const staged = stageSource(repo, "HEAD", target);
    assert.equal(staged.dirty, true);
    assert.equal(staged.commit, git(repo, ["rev-parse", "HEAD"]).trim());
    assert.deepEqual(listFiles(target), [
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES.txt",
      PLUGIN_NOTICES,
      "src/a.ts",
    ]);
    assert.equal(readFileSync(join(target, "src/a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(readFileSync(join(target, "README.md"), "utf8"), PUBLIC_README);
    assert.equal(readFileSync(join(target, "THIRD_PARTY_NOTICES.txt"), "utf8"), NOTICES);
    assert.deepEqual(scanTree(target, "/nonexistent-home"), []);
  });

  it("stages the content of the given ref, not of HEAD, and reports a clean tree", () => {
    const repo = repoWith(PRIVATE);
    const first = git(repo, ["rev-parse", "HEAD"]).trim();
    commit(repo, { "src/a.ts": "export const a = 3;\n" });
    const target = freshDir();
    const staged = stageSource(repo, first, target);
    assert.equal(staged.commit, first);
    assert.equal(staged.dirty, false);
    assert.equal(readFileSync(join(target, "src/a.ts"), "utf8"), "export const a = 1;\n");
  });

  it("keeps README.md of a public ref, which has no docs tree", () => {
    const repo = repoWith({
      [ALLOWLIST]: "src\nlocal.paseocontrol.e1spike.sdPlugin\n",
      "README.md": PUBLIC_README,
      "src/a.ts": "export const a = 1;\n",
      [PLUGIN_NOTICES]: NOTICES,
    });
    const target = freshDir();
    stageSource(repo, "HEAD", target);
    assert.equal(readFileSync(join(target, "README.md"), "utf8"), PUBLIC_README);
  });

  it("refuses a private ref without the public README instead of exporting the private one", () => {
    const repo = repoWith({ ...PRIVATE, [PRIVATE_PUBLIC_README]: "" });
    git(repo, ["rm", "-q", PRIVATE_PUBLIC_README]);
    commit(repo, {});
    const target = freshDir();
    assert.throws(() => stageSource(repo, "HEAD", target), /README\.md is not in/);
  });

  it("refuses a missing allowlisted path, an unknown ref and a non-empty target", () => {
    const missing = repoWith({ ...PRIVATE, [ALLOWLIST]: "src\nnot-there\n" });
    assert.throws(() => stageSource(missing, "HEAD", freshDir()), /not in .*: not-there/);
    const repo = repoWith(PRIVATE);
    assert.throws(() => stageSource(repo, "no-such-ref", freshDir()));
    assert.throws(() => stageSource(repo, "--output=x", freshDir()));
    const target = freshDir();
    write(target, { "left-over.txt": "x" });
    assert.throws(() => stageSource(repo, "HEAD", target), /is not empty/);
  });
});

describe("non-regular entries", () => {
  it("rejects a symbolic link to a file outside the tree before reading it", () => {
    const outside = freshDir();
    write(outside, { "sentinel.txt": "SENTINEL outside the tree\n" });
    const root = freshDir();
    write(root, { "src/a.ts": "export const a = 1;\n" });
    symlinkSync(join(outside, "sentinel.txt"), join(root, "src/linked.ts"));
    assert.throws(() => listFiles(root), /src\/linked\.ts: not a regular file/);
    assert.throws(() => scanTree(root, "/nonexistent-home"), /not a regular file/);
    assert.throws(() => contentManifest(root), /not a regular file/);
  });

  it("refuses a committed symbolic link in the staged source", () => {
    const repo = repoWith(PRIVATE);
    symlinkSync("../LICENSE", join(repo, "src/link.ts"));
    commit(repo, {});
    const target = freshDir();
    stageSource(repo, "HEAD", target);
    assert.throws(() => scanTree(target, "/nonexistent-home"), /src\/link\.ts: not a regular/);
  });
});

describe("contentManifest", () => {
  it("lists every file with its SHA-256 and changes when a file's content does", () => {
    const root = freshDir();
    write(root, { "b.txt": "b", "a/c.txt": "c" });
    const before = contentManifest(root);
    assert.match(before, /^[0-9a-f]{64} {2}a\/c\.txt\n[0-9a-f]{64} {2}b\.txt\n$/);
    write(root, { "b.txt": "B" });
    assert.notEqual(contentManifest(root), before, "same names, other content");
  });
});

describe("forbiddenPathReason", () => {
  it("rejects checkout, build, private and secret files anywhere in the tree", () => {
    for (const path of [
      ".git/config",
      "node_modules/x/index.js",
      "dist/a.js",
      "release/a.streamDeckPlugin",
      `docs/plan${MD}`,
      "src/.env",
      ".env.local",
      `AGENTS${MD}`,
      `sub/CLAUDE${MD}`,
      "npm-debug.log",
      "key.pem",
      "local.paseocontrol.e1spike.sdPlugin/bin/plugin.js",
      "local.paseocontrol.e1spike.sdPlugin/ui/connection.js",
      "local.paseocontrol.e1spike.sdPlugin/logs/a.txt",
    ]) {
      assert.notEqual(forbiddenPathReason(path), null, path);
    }
  });

  it("accepts the source files of the public tree", () => {
    for (const path of [
      "README.md",
      "src/spike/plugin.ts",
      "test/support/fixtures.ts",
      "local.paseocontrol.e1spike.sdPlugin/ui/workspace.js",
      ".githooks/pre-commit",
    ]) {
      assert.equal(forbiddenPathReason(path), null, path);
    }
  });
});

describe("forbiddenText", () => {
  const home = "/Users/example-owner";
  it("finds this machine's home, GitLab addresses, internal documents and private keys", () => {
    // Split so that the secret scanner of this repository does not take it for a key.
    const key = `${["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" ")}\n${"A".repeat(64)}\n`;
    assert.deepEqual(forbiddenText(`${home}/project/x`, home), ["this machine's home directory"]);
    assert.deepEqual(forbiddenText(`git@${GITLAB}:owner/repo.git`, home), ["a GitLab address"]);
    assert.deepEqual(forbiddenText(`see docs/plan${MD}`, home), [
      "a reference to an internal document",
    ]);
    assert.deepEqual(forbiddenText(`see AGENTS${MD}`, home), ["a reference to agent rules"]);
    assert.deepEqual(forbiddenText(key, home), ["a private key"]);
  });

  it("leaves the test suite's synthetic paths and key-shaped fixtures alone", () => {
    for (const text of [
      "ws://u:p@127.0.0.1/ws /Users/someone/private",
      "-----BEGIN RSA PRIVATE KEY-----",
      "docs/reviews/",
      "GitLab token",
      "the AGENTS of a workspace",
    ]) {
      assert.deepEqual(forbiddenText(text, home), [], text);
    }
  });
});

describe("checksums", () => {
  it("writes shasum lines that verify, and catches changed, missing, extra and malformed entries", () => {
    const directory = freshDir();
    write(directory, { "a.streamDeckPlugin": "package" });
    writeFileSync(join(directory, CHECKSUMS), checksumsText(directory, ["a.streamDeckPlugin"]));
    assert.match(
      readFileSync(join(directory, CHECKSUMS), "utf8"),
      /^[0-9a-f]{64} {2}a\.streamDeckPlugin\n$/,
    );
    assert.deepEqual(verifyChecksums(directory), []);

    write(directory, { "a.streamDeckPlugin": "changed", "extra.txt": "x" });
    assert.deepEqual(verifyChecksums(directory), [
      "a.streamDeckPlugin: checksum differs",
      "extra.txt: not in SHA256SUMS",
    ]);
    writeFileSync(join(directory, CHECKSUMS), `${"0".repeat(64)}  gone\nnot a line\n`);
    assert.deepEqual(verifyChecksums(directory), [
      "gone: missing",
      "malformed line: not a line",
      "a.streamDeckPlugin: not in SHA256SUMS",
      "extra.txt: not in SHA256SUMS",
    ]);
  });
});

describe("this tree's public files", () => {
  it("name only existing paths and pass the scan", () => {
    const paths = parseAllowlist(readFileSync(ALLOWLIST, "utf8"));
    // In a git checkout only tracked files count (ignored build output and
    // local files may sit next to them); an exported tree has no others.
    const top = ((): string | null => {
      try {
        return realpathSync(git(".", ["rev-parse", "--show-toplevel"]).trim());
      } catch {
        return null;
      }
    })();
    const files =
      top === realpathSync(".")
        ? git(".", ["ls-files", "--", ...paths])
            .split("\n")
            .filter(Boolean)
        : paths.flatMap((path) =>
            statSync(path).isDirectory()
              ? listFiles(path).map((file) => `${path}/${file}`)
              : [path],
          );
    assert.ok(files.length > 100, "the allowlist names the source tree");
    const problems: string[] = [];
    for (const file of files) {
      const reason = forbiddenPathReason(file);
      // An exported tree that was built has the build output next to it.
      if (reason === "build output") continue;
      if (reason !== null) problems.push(`${file}: ${reason}`);
      const data = readFileSync(file);
      if (data.includes(0)) continue;
      for (const finding of forbiddenText(data.toString("utf8"), "/nonexistent-home")) {
        problems.push(`${file}: ${finding}`);
      }
    }
    assert.deepEqual(problems, []);
  });
});
