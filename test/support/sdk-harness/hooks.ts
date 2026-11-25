import { registerHooks } from "node:module";
import { harness } from "./state.ts";

/**
 * Import hooks for the SDK adapter check (M11c), registered with --import in
 * the child process only. When the real plugin entry (src/spike/plugin.ts)
 * imports the Stream Deck SDK, the Paseo client package or the runtime, it
 * gets the fakes next to this file; every other import loads for real. The
 * load hook records any real SDK or client module that is loaded anyway.
 */

const PLUGIN_ENTRY = new URL("../../../src/spike/plugin.ts", import.meta.url).href;
const FAKES: Readonly<Record<string, string>> = {
  "@elgato/streamdeck": new URL("./fake-streamdeck.ts", import.meta.url).href,
  "@getpaseo/client": new URL("./fake-paseo-client.ts", import.meta.url).href,
  "./plugin-runtime.ts": new URL("./fake-runtime.ts", import.meta.url).href,
};
const GUARDED_PACKAGES = ["@elgato/streamdeck", "@getpaseo/client"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fake = context.parentURL === PLUGIN_ENTRY ? FAKES[specifier] : undefined;
    return fake === undefined ? nextResolve(specifier, context) : { url: fake, shortCircuit: true };
  },
  load(url, context, nextLoad) {
    for (const name of GUARDED_PACKAGES) {
      if (url.includes(`/node_modules/${name}/`)) harness.loadedPackages.add(name);
    }
    return nextLoad(url, context);
  },
});
