/**
 * The plugin's action UUIDs (manifest.json) and the order plugin.ts
 * registers them in. Free of side effects, so tests can import it (M11a).
 */
export const ACTION_IDS = {
  workspace: "local.paseocontrol.e1spike.workspace",
  slot: "local.paseocontrol.e1spike.slot",
  pages: "local.paseocontrol.e1spike.pages",
  usage: "local.paseocontrol.e1spike.usage",
  attention: "local.paseocontrol.e1spike.attention",
} as const;

export type ActionName = keyof typeof ACTION_IDS;

/** Registration order, as plugin.ts before M11a, without the removed E1 action. */
export const REGISTRATION_ORDER: readonly ActionName[] = [
  "workspace",
  "slot",
  "pages",
  "usage",
  "attention",
];
