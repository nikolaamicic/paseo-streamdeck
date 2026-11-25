import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { defaultConfigPath } from "../spike/test-agent-config.ts";
import { MAX_LEGACY_BYTES, type LegacyFileRead } from "./connection-model.ts";

/**
 * Reads the legacy E1 file (C3a1) for
 * the connection model: read-only and bounded. It never writes, renames
 * or deletes the file. The feed lifecycle reads it once per start (C3a3).
 *
 * - The file is opened once and checked on that handle (`fstat`), so the
 *   checked and the read file are the same; `O_NONBLOCK` keeps a FIFO at
 *   the path from blocking the open.
 * - At most `MAX_LEGACY_BYTES + 1` bytes are read, whatever the size said:
 *   a file that grows between the check and the read is never read whole.
 *   One byte over the limit is enough for the model to call it malformed.
 * - The handle is closed on every path; a failed close makes the read
 *   unreadable instead of being ignored.
 * - Decoding keeps the text's UTF-8 length, when encoded again, at least
 *   the number of bytes read (a BOM is kept as U+FEFF, invalid or cut
 *   bytes become U+FFFD), so the model's byte limit still holds. This is
 *   about UTF-8 bytes, not the string's `length`.
 */

/** The parts of a file handle the reader uses (node:fs/promises FileHandle). */
export interface LegacyFileHandle {
  stat(): Promise<{ isFile(): boolean }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export type OpenLegacyFile = (path: string, flags: number) => Promise<LegacyFileHandle>;

const READ_LIMIT = MAX_LEGACY_BYTES + 1;
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Up to READ_LIMIT bytes from the start, until end of file. */
async function readBounded(handle: LegacyFileHandle): Promise<Uint8Array> {
  const buffer = new Uint8Array(READ_LIMIT);
  let filled = 0;
  while (filled < READ_LIMIT) {
    const { bytesRead } = await handle.read(buffer, filled, READ_LIMIT - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

export async function readLegacyFile(
  path: string = defaultConfigPath(),
  openFile: OpenLegacyFile = open,
): Promise<LegacyFileRead> {
  let handle: LegacyFileHandle;
  try {
    handle = await openFile(path, OPEN_FLAGS);
  } catch (error: unknown) {
    return isMissing(error) ? { kind: "missing" } : { kind: "unreadable" };
  }
  let result: LegacyFileRead;
  try {
    if (!(await handle.stat()).isFile()) {
      result = { kind: "unreadable" };
    } else {
      const bytes = await readBounded(handle);
      result = { kind: "text", text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
    }
  } catch {
    result = { kind: "unreadable" };
  }
  try {
    await handle.close();
  } catch {
    return { kind: "unreadable" };
  }
  return result;
}
