import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the legacy E1 file lives and the documented default daemon
 * address. The file is optional since C3a3: it may give the E1 key its
 * target and, while nothing is saved in the global settings, an address.
 * It is read by
 * src/connection/legacy-file.ts and interpreted by connection-model.ts;
 * the plugin never writes it.
 */
const CONFIG_RELATIVE_PATH = join(".config", "paseo-control", "e1-test-agent.json");

/** The documented local Paseo daemon (paseo.sh SDK reference, 0.15.4). */
export const DEFAULT_DAEMON_URL = "ws://127.0.0.1:6767/ws";

export function defaultConfigPath(home: string = homedir()): string {
  return join(home, CONFIG_RELATIVE_PATH);
}
