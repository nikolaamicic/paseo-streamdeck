import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Release check for the E1 plugin folder that `streamdeck pack` packages:
 * exactly the expected files (no logs, local config, env files, tests or
 * keys), no private paths, real server IDs or credentials in any text file,
 * and no debugger setting in the manifest.
 */

export const PLUGIN_DIR = "local.paseocontrol.e1spike.sdPlugin";

export const EXPECTED_FILES: readonly string[] = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "bin/package.json",
  "bin/plugin.js",
  "imgs/actions/attention/dial.svg",
  "imgs/actions/attention/icon.svg",
  "imgs/actions/pages/dial.svg",
  "imgs/actions/pages/icon.svg",
  "imgs/actions/slot/icon.svg",
  "imgs/actions/slot/key.svg",
  "imgs/actions/usage/dial.svg",
  "imgs/actions/usage/icon.svg",
  "imgs/actions/workspace/dial.svg",
  "imgs/actions/workspace/icon.svg",
  "imgs/plugin/category-icon.svg",
  "imgs/plugin/marketplace.png",
  "imgs/plugin/marketplace@2x.png",
  "layouts/attention.json",
  "layouts/segment.json",
  "layouts/usage.json",
  "manifest.json",
  "ui/connection.html",
  "ui/connection.js",
  "ui/workspace.html",
  "ui/workspace.js",
];

const FORBIDDEN_CONTENT: readonly { name: string; pattern: RegExp }[] = [
  { name: "macOS home path", pattern: /\/Users\// },
  { name: "Linux home path", pattern: /\/home\// },
  { name: "Paseo server ID", pattern: /srv_[A-Za-z0-9]{6,}/ },
  { name: "private key", pattern: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { name: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{36}/ },
  { name: "GitLab token", pattern: /glpat-[A-Za-z0-9_-]{20}/ },
];

const TEXT_EXTENSIONS = [".js", ".json", ".svg", ".txt", ".html"];

/** Inspector scripts run in Stream Deck's browser view: no Node module may reach them. */
const NODE_IN_BROWSER: readonly { name: string; pattern: RegExp }[] = [
  { name: "a node: import", pattern: /["']node:/ },
  { name: "a require call", pattern: /\brequire\(/ },
  { name: "a module import", pattern: /^\s*import\s/m },
];

export function inventoryProblems(
  files: readonly string[],
  readText: (path: string) => string,
): string[] {
  const problems: string[] = [];
  const present = new Set(files);
  for (const file of files) {
    if (!EXPECTED_FILES.includes(file)) problems.push(`unexpected file: ${file}`);
  }
  for (const file of EXPECTED_FILES) {
    if (!present.has(file)) problems.push(`missing file: ${file}`);
  }
  for (const file of files) {
    if (!TEXT_EXTENSIONS.some((extension) => file.endsWith(extension))) continue;
    const text = readText(file);
    for (const { name, pattern } of FORBIDDEN_CONTENT) {
      if (pattern.test(text)) problems.push(`${name} found in ${file}`);
    }
  }
  for (const file of files) {
    if (!file.startsWith("ui/") || !file.endsWith(".js")) continue;
    const text = readText(file);
    for (const { name, pattern } of NODE_IN_BROWSER) {
      if (pattern.test(text)) problems.push(`${name} in the browser script ${file}`);
    }
  }
  if (present.has("manifest.json")) {
    const manifest: unknown = JSON.parse(readText("manifest.json"));
    const nodejs =
      typeof manifest === "object" && manifest !== null && "Nodejs" in manifest
        ? manifest.Nodejs
        : null;
    if (typeof nodejs !== "object" || nodejs === null || !("Version" in nodejs)) {
      problems.push("manifest has no Nodejs.Version");
    } else {
      if (nodejs.Version !== "24") problems.push("manifest Nodejs.Version is not 24");
      if ("Debug" in nodejs) problems.push("manifest enables the Node.js debugger");
    }
  }
  return problems;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

async function main(): Promise<number> {
  const root = fileURLToPath(new URL(`../../${PLUGIN_DIR}`, import.meta.url));
  const files = await listFiles(root);
  const texts = new Map<string, string>();
  for (const file of files) texts.set(file, await readFile(join(root, file), "utf8"));
  const problems = inventoryProblems(files, (file) => texts.get(file) ?? "");
  for (const file of files) process.stdout.write(`  ${file}\n`);
  for (const problem of problems) process.stdout.write(`PROBLEM: ${problem}\n`);
  process.stdout.write(
    problems.length === 0
      ? `plugin inventory OK (${files.length} files)\n`
      : `plugin inventory FAILED\n`,
  );
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
