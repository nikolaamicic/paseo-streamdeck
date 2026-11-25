/**
 * One release version in three places: package.json `version` (X.Y.Z),
 * package-lock.json (top level and the root package entry) and the plugin
 * manifest `Version`, which Stream Deck expects as four numbers (X.Y.Z.0).
 * Returns every disagreement; an empty list means they agree.
 */

const SEMVER_CORE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

export function releaseVersionProblems(
  packageJson: unknown,
  packageLock: unknown,
  manifest: unknown,
): string[] {
  const version = field(packageJson, "version");
  if (typeof version !== "string" || !SEMVER_CORE.test(version)) {
    return [`package.json version ${JSON.stringify(version)} is not X.Y.Z`];
  }
  const expected: readonly (readonly [string, unknown, string])[] = [
    ["package-lock.json version", field(packageLock, "version"), version],
    [
      'package-lock.json packages[""].version',
      field(packageLock, "packages", "", "version"),
      version,
    ],
    ["manifest.json Version", field(manifest, "Version"), `${version}.0`],
  ];
  return expected
    .filter(([, actual, wanted]) => actual !== wanted)
    .map(
      ([where, actual, wanted]) =>
        `${where} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`,
    );
}
