import type { AgentAddress } from "../agents/agent-model.ts";
import type { SlotState } from "../navigation/navigation.ts";
import type { OpenOutcome } from "../opener/open-agent.ts";
import { decidePress } from "./press-guard.ts";

/**
 * Key press wiring of plugin.ts, moved here unchanged so it can be tested
 * without the Stream Deck SDK (M3). plugin.ts passes the real renderer,
 * directory, recovery, opener and action; tests pass fakes.
 */

/** Stream Deck + keys: 4 columns × 2 rows. */
const KEY_COLUMNS = 4;
const KEY_ROWS = 2;

/**
 * The slot (0–7) of a workspace key from its coordinates, or -1 outside the
 * Stream Deck + key grid (such a key shows nothing). Coordinates are
 * missing for keys inside a multi-action.
 */
export function slotFromCoordinates(
  coordinates: { readonly column: number; readonly row: number } | undefined,
): number {
  return coordinates !== undefined && coordinates.column < KEY_COLUMNS && coordinates.row < KEY_ROWS
    ? coordinates.row * KEY_COLUMNS + coordinates.column
    : -1;
}

/** The agent a press on a workspace key may open: the one placed on its slot. */
export function slotPressTarget(state: SlotState | null): AgentAddress | null {
  return state?.kind === "agent" ? state.address : null;
}

/** What a press reads from a key's renderer (KeyRenderer). */
export interface RenderedKey {
  readonly renderedIdentity: AgentAddress | null;
  readonly renderedRetry: boolean;
  readonly pressChangePending: boolean;
}

export interface KeyPressDeps {
  /** The pressed key's renderer; undefined when the key is not registered. */
  readonly renderer: RenderedKey | undefined;
  /** The agent that should be on the key now (configured or placed). */
  readonly expected: AgentAddress | null;
  /** Whether the agent is in the current directory. */
  readonly isPresent: (address: AgentAddress) => boolean;
  /** Starts at most one recovery attempt; false when none is available. */
  readonly retryNow: () => boolean;
  readonly open: (address: AgentAddress) => Promise<OpenOutcome>;
  readonly showAlert: () => Promise<void>;
  readonly showOk: () => Promise<void>;
  /** Fixed codes only. */
  readonly log: (message: string) => void;
}

/**
 * A key press acts only on what the key last showed (press-guard.ts):
 * `expected` is the agent that should be on the key now, `isPresent` whether
 * it is still in the directory.
 */
export async function handleKeyPress(deps: KeyPressDeps): Promise<void> {
  const { renderer, expected } = deps;
  const present = expected !== null && deps.isPresent(expected) ? expected : null;
  const decision = decidePress({
    rendered: renderer?.renderedIdentity ?? null,
    renderedRetry: renderer?.renderedRetry ?? false,
    changePending: renderer?.pressChangePending ?? true,
    configured: expected,
    current: present,
  });
  if (decision.kind === "refuse") {
    deps.log(`press refused: ${decision.reason}`);
    await deps.showAlert();
    return;
  }
  if (decision.kind === "retry") {
    // Starts at most one attempt; false while one is already running.
    const started = deps.retryNow();
    deps.log(`retry: ${started ? "started" : "not available"}`);
    if (!started) await deps.showAlert();
    return;
  }
  const outcome = await deps.open(decision.target);
  deps.log(`open: ${outcome}`);
  if (outcome === "requested") await deps.showOk();
  else await deps.showAlert();
}
