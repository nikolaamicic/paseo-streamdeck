/**
 * Stages the public source tree of a committed ref: the files that
 * scripts/public/public-files.txt allows, the public README and a root copy
 * of the plugin's third-party notices (release-files.ts), then scans the
 * result for files and text that must not be published. Builds nothing and
 * publishes nothing.
 *
 *   npm run release:stage -- [ref] [target]
 *
 * Defaults: ref HEAD, target release/public-source (ignored by git).
 */
import { homedir } from "node:os";
import { scanTree, stageSource } from "./release-files.ts";

const ref = process.argv[2] ?? "HEAD";
const target = process.argv[3] ?? "release/public-source";

const staged = stageSource(".", ref, target);
if (staged.dirty) {
  process.stderr.write(`note: uncommitted changes are not part of ${staged.commit}\n`);
}
const problems = scanTree(target, homedir());
if (problems.length > 0) {
  process.stderr.write(`${target} must not be published:\n${problems.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `staged ${String(staged.files.length)} files of ${staged.commit} and ${String(staged.overlays.length)} overlays in ${target}\n`,
  );
}
