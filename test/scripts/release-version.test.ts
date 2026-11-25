import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { releaseVersionProblems } from "../../scripts/plugin/release-version.ts";

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const value: unknown = JSON.parse(text);
  return value;
}

function lock(version: unknown, rootVersion: unknown = version): unknown {
  return { version, packages: { "": { version: rootVersion } } };
}

describe("release version", () => {
  it("is the same in package.json, package-lock.json and the plugin manifest", async () => {
    const problems = releaseVersionProblems(
      await readJson("package.json"),
      await readJson("package-lock.json"),
      await readJson("local.paseocontrol.e1spike.sdPlugin/manifest.json"),
    );
    assert.deepEqual(problems, []);
  });

  it("reports each place that disagrees", () => {
    assert.deepEqual(
      releaseVersionProblems({ version: "0.1.4" }, lock("0.1.4"), { Version: "0.1.4.0" }),
      [],
    );
    assert.deepEqual(
      releaseVersionProblems({ version: "0.1.4" }, lock("0.1.3", "0.1.4"), { Version: "0.1.3.0" }),
      [
        'package-lock.json version is "0.1.3", expected "0.1.4"',
        'manifest.json Version is "0.1.3.0", expected "0.1.4.0"',
      ],
    );
    assert.deepEqual(
      releaseVersionProblems({ version: "0.1.4" }, lock("0.1.4", "0.1.3"), { Version: "0.1.4" }),
      [
        'package-lock.json packages[""].version is "0.1.3", expected "0.1.4"',
        'manifest.json Version is "0.1.4", expected "0.1.4.0"',
      ],
    );
  });

  it("rejects a package version the manifest cannot express", () => {
    for (const version of ["0.1.4-beta.1", "0.1", "v0.1.4", undefined]) {
      assert.equal(
        releaseVersionProblems({ version }, lock(version), { Version: `${String(version)}.0` })
          .length,
        1,
      );
    }
  });
});
