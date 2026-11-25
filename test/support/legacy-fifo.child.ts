import { readLegacyFile } from "../../src/connection/legacy-file.ts";

/**
 * Child process for the legacy reader's FIFO check (C3a1): reads the path
 * given as the only argument with the real readLegacyFile and prints the
 * result as JSON. Run only by test/connection/legacy-file.test.ts, which
 * bounds it with a timeout and kills it, so a blocking open cannot keep a
 * test process alive.
 */

const path = process.argv[2];
if (path === undefined) throw new Error("usage: legacy-fifo.child.ts <path>");
process.stdout.write(JSON.stringify(await readLegacyFile(path)));
