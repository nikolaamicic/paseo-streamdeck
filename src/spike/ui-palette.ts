/**
 * Colors shared by the Elgato UI modules (M7): key-svg.ts, usage-dial.ts and
 * attention-dial.ts. Names describe the color, not a meaning: the same color
 * plays different roles (e.g. SILVER is the key footer, the Usage bar and the
 * calm Attention text), so each module keeps its own semantic map and picks
 * from here. Solid hex only: on the device an rgba() color was drawn
 * near-black (2026-11-15 hardware probe; cause not proven).
 *
 * navigation.ts keeps its own two colors: they are written in lowercase in
 * the strip payload and it stays free of UI modules.
 */

export const WHITE = "#FFFFFF";
export const SILVER = "#D0D0D6";
export const GREY = "#A6A6AE";
export const AMBER = "#FFB938";
export const RED = "#FF7B6B";
