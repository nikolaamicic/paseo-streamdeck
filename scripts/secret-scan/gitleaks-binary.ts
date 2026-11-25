import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Pinned Gitleaks release used by the local hook and the history scan.
 *
 * The archive hashes were taken from the official release
 * (https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) and
 * cross-checked on 2026-11-15 against `gitleaks_8.30.1_checksums.txt` and the
 * GitHub asset digests. The release publishes no signatures or artifact
 * attestations, so these pinned hashes are the trust anchor.
 */
export const GITLEAKS_VERSION = "8.30.1";

export const SUPPORTED_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
] as const;
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export const ARCHIVE_SHA256: Readonly<Record<SupportedPlatform, string>> = {
  "darwin-arm64": "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  "darwin-x64": "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  "linux-arm64": "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  "linux-x64": "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
};

const execFileAsync = promisify(execFile);
const BINARY_NAME = "gitleaks";
const BINARY_HASH_FILE = "gitleaks.sha256";
const DOWNLOAD_TIMEOUT_MS = 120_000;

export class GitleaksSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitleaksSetupError";
  }
}

export function platformKey(platform: NodeJS.Platform, arch: string): SupportedPlatform {
  const os = platform === "darwin" || platform === "linux" ? platform : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (os === null || cpu === null) {
    throw new GitleaksSetupError(`unsupported platform for Gitleaks: ${platform}/${arch}`);
  }
  return `${os}-${cpu}`;
}

export function archiveName(target: SupportedPlatform): string {
  return `gitleaks_${GITLEAKS_VERSION}_${target.replace("-", "_")}.tar.gz`;
}

export function downloadUrl(target: SupportedPlatform): string {
  return `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archiveName(target)}`;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Throws unless `data` hashes to exactly `expectedHex`. */
export function assertSha256(data: Uint8Array, expectedHex: string, label: string): void {
  const actual = sha256Hex(data);
  if (actual !== expectedHex) {
    throw new GitleaksSetupError(
      `${label}: SHA-256 mismatch (expected ${expectedHex}, got ${actual}); refusing to use it`,
    );
  }
}

export type Fetcher = (url: string) => Promise<Uint8Array>;

const httpsFetcher: Fetcher = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new GitleaksSetupError(`download failed: HTTP ${response.status} for ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

export interface EnsureOptions {
  /** Directory that holds downloaded binaries, e.g. `<repo>/.cache/gitleaks`. */
  readonly cacheDir: string;
  readonly target: SupportedPlatform;
  readonly fetcher?: Fetcher;
  readonly log?: (message: string) => void;
}

async function readIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function reportedVersion(binary: string): Promise<string> {
  const { stdout } = await execFileAsync(binary, ["version"], { timeout: 30_000 });
  return stdout.trim();
}

/**
 * Returns the path of a verified Gitleaks binary, downloading and verifying
 * the pinned release archive when no previously verified binary is cached.
 */
export async function ensureGitleaks(options: EnsureOptions): Promise<string> {
  const log = options.log ?? (() => undefined);
  const dir = join(options.cacheDir, GITLEAKS_VERSION, options.target);
  const binary = join(dir, BINARY_NAME);
  const hashFile = join(dir, BINARY_HASH_FILE);

  const [cachedBinary, cachedHash] = await Promise.all([
    readIfExists(binary),
    readIfExists(hashFile),
  ]);
  if (cachedBinary !== null && cachedHash !== null) {
    if (sha256Hex(cachedBinary) === Buffer.from(cachedHash).toString("utf8").trim()) {
      return binary;
    }
    log("cached Gitleaks binary does not match its recorded hash; downloading again");
  }

  const url = downloadUrl(options.target);
  log(`downloading Gitleaks ${GITLEAKS_VERSION} (${options.target}) from ${url}`);
  const archive = await (options.fetcher ?? httpsFetcher)(url);
  assertSha256(archive, ARCHIVE_SHA256[options.target], archiveName(options.target));

  await mkdir(options.cacheDir, { recursive: true });
  const staging = await mkdtemp(join(options.cacheDir, ".staging-"));
  try {
    const archivePath = join(staging, archiveName(options.target));
    await writeFile(archivePath, archive);
    await execFileAsync("tar", ["-xzf", archivePath, "-C", staging, BINARY_NAME], {
      timeout: 60_000,
    });
    const extracted = join(staging, BINARY_NAME);
    await chmod(extracted, 0o755);
    const version = await reportedVersion(extracted);
    if (version !== GITLEAKS_VERSION) {
      throw new GitleaksSetupError(`extracted Gitleaks reports version "${version}"`);
    }
    await mkdir(dir, { recursive: true });
    await rename(extracted, binary);
    await writeFile(hashFile, `${sha256Hex(await readFile(binary))}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  log(`Gitleaks ${GITLEAKS_VERSION} verified (archive SHA-256 matches the pinned value)`);
  return binary;
}
