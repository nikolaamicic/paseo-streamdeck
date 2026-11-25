// Bundles the compiled E1 plugin (dist/, from `npm run build`) into the
// Stream Deck plugin folder, following the official @elgato/cli 1.10.4
// template (node resolution, CommonJS interop, module package.json).
import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";

const sdPlugin = "local.paseocontrol.e1spike.sdPlugin";

const plugin = {
  input: "dist/spike/plugin.js",
  output: { file: `${sdPlugin}/bin/plugin.js`, format: "es", sourcemap: false },
  plugins: [
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
    {
      name: "emit-module-package-file",
      generateBundle() {
        this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
      },
    },
  ],
};

// The Property Inspector's connection section (C4b): a browser script for
// Stream Deck's inspector view. It imports only the shared protocol and the
// page modules, never Node; the inventory checks the output for Node imports.
const inspector = {
  input: "dist/inspector/page/entry.js",
  output: { file: `${sdPlugin}/ui/connection.js`, format: "iife", sourcemap: false },
  plugins: [nodeResolve({ browser: true, preferBuiltins: false })],
};

export default [plugin, inspector];
