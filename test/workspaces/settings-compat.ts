import type { DialAction } from "@elgato/streamdeck";
import { startInSettings, type StartInSettings } from "../../src/workspaces/start-in-settings.ts";

/**
 * Compile-time check only (not a test file, never executed): the stored
 * Start in record satisfies the settings constraint of @elgato/streamdeck
 * 3.0.4 (DialAction<TSettings extends JsonObject>) and can be stored with
 * setSettings. `npm run typecheck` fails if it cannot.
 */
export function storeStartIn(action: DialAction<StartInSettings>): Promise<void> {
  return action.setSettings(startInSettings(null));
}
