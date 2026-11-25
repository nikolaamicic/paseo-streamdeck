import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

/**
 * The plugin installer carries the project's own license: the LICENSE in
 * the plugin folder must stay a byte-for-byte copy of the root LICENSE.
 */
describe("the plugin's LICENSE", () => {
  it("is identical to the root LICENSE", async () => {
    const root = await readFile(new URL("../../LICENSE", import.meta.url));
    const plugin = await readFile(
      new URL("../../local.paseocontrol.e1spike.sdPlugin/LICENSE", import.meta.url),
    );
    assert.ok(root.equals(plugin), "copy LICENSE into local.paseocontrol.e1spike.sdPlugin/");
    assert.match(root.toString("utf8"), /^MIT License\n\nCopyright \(c\) 2026 Nikola Micic\n/);
  });
});
