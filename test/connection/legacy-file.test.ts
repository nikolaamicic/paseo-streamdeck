import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { interpretLegacyFile, MAX_LEGACY_BYTES } from "../../src/connection/connection-model.ts";
import {
  readLegacyFile,
  type LegacyFileHandle,
  type OpenLegacyFile,
} from "../../src/connection/legacy-file.ts";

/**
 * The read-only, bounded legacy file reader (C3a1). Real files live in a
 * fresh temporary directory; the plugin's real config path is never read.
 * Read, stat and close failures go through the reader's narrow open seam.
 */

let dir = "";
const file = (name: string) => join(dir, name);
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "paseo-legacy-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const FIFO_CHILD = fileURLToPath(new URL("../support/legacy-fifo.child.ts", import.meta.url));
/** Generous: the child normally finishes in well under a second. */
const FIFO_CHILD_TIMEOUT_MS = 10_000;

interface ChildResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly output: string;
}

/**
 * Runs the real reader on `path` in its own process. A blocked open keeps
 * a process alive past any test timeout, so the child is killed (SIGKILL)
 * at the deadline and the callback runs only after it has exited.
 */
function runFifoChild(path: string): Promise<ChildResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [FIFO_CHILD, path],
      { timeout: FIFO_CHILD_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        const timedOut = error?.killed === true;
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, timedOut, stdout, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

describe("readLegacyFile on real files", () => {
  it("a missing file is missing", async () => {
    assert.deepEqual(await readLegacyFile(file("absent.json")), { kind: "missing" });
  });

  it("returns the file's text unchanged and leaves the file as it was", async () => {
    const path = file("valid.json");
    const content = '{"serverId":"srv_TestServer01","agentId":"agent-1"}\n';
    await writeFile(path, content);
    const before = await stat(path);
    assert.deepEqual(await readLegacyFile(path), { kind: "text", text: content });
    const afterRead = await stat(path);
    assert.equal(await readFile(path, "utf8"), content);
    assert.equal(afterRead.mtimeMs, before.mtimeMs, "not written");
    assert.equal(afterRead.size, before.size);
  });

  it("keeps multi-byte UTF-8 exactly", async () => {
    const path = file("utf8.json");
    // Synthetic multi-byte text: Latin letters with diacritics, CJK and an emoji.
    const content = JSON.stringify({ serverId: "čćžšđ — 東京 — 🙂" });
    await writeFile(path, content);
    assert.deepEqual(await readLegacyFile(path), { kind: "text", text: content });
  });

  it("a file of exactly the limit is read whole and is not too large for the model", async () => {
    const path = file("limit.json");
    const content = `{"serverId":"${"a".repeat(MAX_LEGACY_BYTES - 15)}"}`;
    assert.equal(bytes(content), MAX_LEGACY_BYTES);
    await writeFile(path, content);
    const read = await readLegacyFile(path);
    assert.deepEqual(read, { kind: "text", text: content });
    assert.notDeepEqual(
      interpretLegacyFile(read).connection,
      { kind: "error", error: "malformed" },
      "not refused for its size",
    );
  });

  it("a larger file is read only to one byte over the limit, which the model calls malformed", async () => {
    for (const size of [MAX_LEGACY_BYTES + 1, 100_000]) {
      const path = file(`big-${String(size)}.json`);
      await writeFile(path, "x".repeat(size));
      const read = await readLegacyFile(path);
      assert.ok(read.kind === "text");
      assert.equal(bytes(read.text), MAX_LEGACY_BYTES + 1);
      assert.deepEqual(interpretLegacyFile(read).connection, { kind: "error", error: "malformed" });
    }
  });

  it("a multi-byte character cut at the read limit becomes U+FFFD and is over the limit", async () => {
    const path = file("cut.json");
    // 4096 one-byte characters, then "é" (2 bytes): the read stops after
    // byte 4097, which is the first half of "é".
    await writeFile(path, `${"x".repeat(MAX_LEGACY_BYTES)}é`);
    const read = await readLegacyFile(path);
    assert.deepEqual(read, { kind: "text", text: `${"x".repeat(MAX_LEGACY_BYTES)}\ufffd` });
    assert.deepEqual(interpretLegacyFile(read).connection, { kind: "error", error: "malformed" });
  });

  it("a whole multi-byte character that ends past the limit also counts as over", async () => {
    const path = file("whole.json");
    // 4095 one-byte characters, then "é" (bytes 4096 and 4097) and more.
    await writeFile(path, `${"x".repeat(MAX_LEGACY_BYTES - 1)}éé`);
    const read = await readLegacyFile(path);
    assert.deepEqual(read, { kind: "text", text: `${"x".repeat(MAX_LEGACY_BYTES - 1)}é` });
    assert.deepEqual(interpretLegacyFile(read).connection, { kind: "error", error: "malformed" });
  });

  it("a BOM is kept, so the model does not parse it as JSON", async () => {
    const path = file("bom.json");
    await writeFile(path, '\ufeff{"serverId":"srv_TestServer01","agentId":"agent-1"}');
    const read = await readLegacyFile(path);
    assert.ok(read.kind === "text" && read.text.startsWith("\ufeff"));
    assert.deepEqual(interpretLegacyFile(read).connection, { kind: "error", error: "malformed" });
  });

  it("invalid UTF-8 becomes U+FFFD without shrinking", async () => {
    const path = file("invalid-utf8.json");
    const raw = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    await writeFile(path, raw);
    const read = await readLegacyFile(path);
    assert.deepEqual(read, { kind: "text", text: "{\ufffd\ufffd}" });
    assert.ok(bytes(read.text) >= raw.byteLength);
  });

  it("a directory at the path is unreadable", async () => {
    const path = file("a-directory");
    await mkdir(path);
    assert.deepEqual(await readLegacyFile(path), { kind: "unreadable" });
  });

  it("a FIFO at the path is unreadable and does not block the open (child process)", async (t) => {
    const path = file("a-fifo");
    try {
      execFileSync("mkfifo", [path]);
    } catch (error: unknown) {
      // Only a missing mkfifo command skips; any other failure is a failure.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        t.skip("mkfifo is not available here");
        return;
      }
      throw error;
    }
    const result = await runFifoChild(path);
    assert.equal(
      result.timedOut,
      false,
      "the child finished on its own; a blocking open would not",
    );
    assert.equal(result.code, 0, `the child failed:\n${result.output}`);
    assert.deepEqual(JSON.parse(result.stdout), { kind: "unreadable" });
  });
});

/** A fake handle; every call is recorded, settles at once or as told. */
function fakeHandle(options: {
  isFile?: boolean;
  statError?: Error;
  /** Bytes each read returns (filled with "x"); undefined = to the end. */
  chunk?: (requested: number) => number;
  readError?: Error;
  closeError?: Error;
}) {
  const calls: string[] = [];
  const requested: { offset: number; length: number; position: number }[] = [];
  const handle: LegacyFileHandle = {
    stat: () => {
      calls.push("stat");
      return options.statError === undefined
        ? Promise.resolve({ isFile: () => options.isFile ?? true })
        : Promise.reject(options.statError);
    },
    read: (buffer, offset, length, position) => {
      calls.push("read");
      requested.push({ offset, length, position });
      if (options.readError !== undefined) return Promise.reject(options.readError);
      const count = Math.min(length, options.chunk?.(length) ?? length);
      buffer.fill(0x78, offset, offset + count);
      return Promise.resolve({ bytesRead: count });
    },
    close: () => {
      calls.push("close");
      return options.closeError === undefined
        ? Promise.resolve()
        : Promise.reject(options.closeError);
    },
  };
  const openFile: OpenLegacyFile = () => Promise.resolve(handle);
  return { openFile, calls, requested };
}

const errorWithCode = (code: string) => Object.assign(new Error(code), { code });

describe("readLegacyFile through the open seam", () => {
  it("an open error other than ENOENT is unreadable", async () => {
    for (const code of ["EACCES", "EISDIR", "ELOOP", "EMFILE"]) {
      const openFile: OpenLegacyFile = () => Promise.reject(errorWithCode(code));
      assert.deepEqual(await readLegacyFile("p", openFile), { kind: "unreadable" });
    }
    const missing: OpenLegacyFile = () => Promise.reject(errorWithCode("ENOENT"));
    assert.deepEqual(await readLegacyFile("p", missing), { kind: "missing" });
  });

  it("a stat or read failure is unreadable, and the handle is still closed", async () => {
    for (const fake of [
      fakeHandle({ statError: new Error("stat") }),
      fakeHandle({ readError: new Error("read") }),
    ]) {
      assert.deepEqual(await readLegacyFile("p", fake.openFile), { kind: "unreadable" });
      assert.equal(fake.calls.at(-1), "close");
      assert.equal(fake.calls.filter((call) => call === "close").length, 1);
    }
  });

  it("not a file: unreadable without reading, and closed", async () => {
    const fake = fakeHandle({ isFile: false });
    assert.deepEqual(await readLegacyFile("p", fake.openFile), { kind: "unreadable" });
    assert.deepEqual(fake.calls, ["stat", "close"]);
  });

  it("a failed close after a good read is unreadable, not ignored", async () => {
    const fake = fakeHandle({ chunk: () => 0, closeError: new Error("close") });
    assert.deepEqual(await readLegacyFile("p", fake.openFile), { kind: "unreadable" });
  });

  it("a file that keeps growing is read only to one byte over the limit", async () => {
    // Every read returns all it was asked for: the file never ends.
    const fake = fakeHandle({});
    const read = await readLegacyFile("p", fake.openFile);
    assert.ok(read.kind === "text" && bytes(read.text) === MAX_LEGACY_BYTES + 1);
    const total = fake.requested.reduce((sum, request) => sum + request.length, 0);
    assert.equal(total, MAX_LEGACY_BYTES + 1, "never asked for more");
    assert.equal(fake.calls.at(-1), "close");
  });

  it("short reads are joined in order until the end of the file", async () => {
    let left = 10;
    const fake = fakeHandle({
      chunk: () => {
        const count = Math.min(3, left);
        left -= count;
        return count;
      },
    });
    assert.deepEqual(await readLegacyFile("p", fake.openFile), {
      kind: "text",
      text: "x".repeat(10),
    });
    assert.deepEqual(
      fake.requested.map((request) => request.position),
      [0, 3, 6, 9, 10],
      "each read continues where the last one ended",
    );
  });
});
