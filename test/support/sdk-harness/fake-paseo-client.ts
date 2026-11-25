import { harness } from "./state.ts";

/** Never called in the adapter check: the runtime is a fake and creates no client. */
export function createPaseoClient(): never {
  harness.events.push("createPaseoClient");
  throw new Error("createPaseoClient must not run in the SDK adapter check");
}
