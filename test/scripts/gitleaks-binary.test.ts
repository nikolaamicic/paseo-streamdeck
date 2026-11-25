import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  ARCHIVE_SHA256,
  archiveName,
  assertSha256,
  downloadUrl,
  ensureGitleaks,
  GitleaksSetupError,
  platformKey,
  SUPPORTED_PLATFORMS,
} from "../../scripts/secret-scan/gitleaks-binary.ts";

describe("platformKey", () => {
  it("maps supported platforms", () => {
    assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
    assert.equal(platformKey("darwin", "x64"), "darwin-x64");
    assert.equal(platformKey("linux", "arm64"), "linux-arm64");
    assert.equal(platformKey("linux", "x64"), "linux-x64");
  });

  it("refuses platforms without a pinned archive", () => {
    assert.throws(() => platformKey("win32", "x64"), GitleaksSetupError);
    assert.throws(() => platformKey("linux", "ia32"), GitleaksSetupError);
  });
});

describe("pinned release", () => {
  it("pins a lowercase SHA-256 for every supported platform", () => {
    for (const target of SUPPORTED_PLATFORMS) {
      assert.match(ARCHIVE_SHA256[target], /^[0-9a-f]{64}$/);
    }
  });

  it("downloads only from the official GitHub release of the pinned version", () => {
    assert.equal(
      downloadUrl("linux-x64"),
      "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz",
    );
    assert.equal(archiveName("darwin-arm64"), "gitleaks_8.30.1_darwin_arm64.tar.gz");
  });
});

describe("assertSha256", () => {
  const abc = new TextEncoder().encode("abc");
  it("accepts matching content (FIPS 180-2 test vector)", () => {
    assert.doesNotThrow(() => {
      assertSha256(abc, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "abc");
    });
  });

  it("rejects any other content", () => {
    assert.throws(() => {
      assertSha256(abc, "0".repeat(64), "abc");
    }, GitleaksSetupError);
  });
});

describe("ensureGitleaks", () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("refuses a download whose checksum does not match and leaves no binary", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "gitleaks-cache-test-"));
    dirs.push(cacheDir);
    const tampered = new TextEncoder().encode("not the official archive");
    await assert.rejects(
      ensureGitleaks({ cacheDir, target: "linux-x64", fetcher: () => Promise.resolve(tampered) }),
      GitleaksSetupError,
    );
    assert.deepEqual(await readdir(cacheDir), []);
  });
});
