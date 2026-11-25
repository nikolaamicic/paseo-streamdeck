import type { AgentAddress } from "../agents/agent-model.ts";
import { sameAddress } from "../agents/agent-model.ts";

export type PressDecision =
  | { readonly kind: "open"; readonly target: AgentAddress }
  | { readonly kind: "retry" }
  | {
      readonly kind: "refuse";
      readonly reason: "nothing_shown" | "identity_changing" | "not_configured" | "not_current";
    };

export interface PressInputs {
  /** Identity of the last completed draw on the pressed key. */
  readonly rendered: AgentAddress | null;
  /** The last completed draw offered Retry. */
  readonly renderedRetry: boolean;
  /** A pending draw would change the identity or the Retry offer. */
  readonly changePending: boolean;
  readonly configured: AgentAddress | null;
  /** Identity of the configured agent in the current directory, if present. */
  readonly current: AgentAddress | null;
}

/**
 * Acts only on what the key last showed: Retry when the drawn key offered it,
 * otherwise opens the drawn identity, and only when it is still the
 * configured agent and present in the directory. Anything uncertain, such as
 * a pending change of what the key shows, is refused (the caller shows an
 * alert) rather than guessed.
 */
export function decidePress(input: PressInputs): PressDecision {
  if (input.changePending) return { kind: "refuse", reason: "identity_changing" };
  if (input.renderedRetry) return { kind: "retry" };
  const rendered = input.rendered;
  if (rendered === null) return { kind: "refuse", reason: "nothing_shown" };
  if (input.configured === null || !sameAddress(rendered, input.configured)) {
    return { kind: "refuse", reason: "not_configured" };
  }
  if (input.current === null || !sameAddress(rendered, input.current)) {
    return { kind: "refuse", reason: "not_current" };
  }
  return { kind: "open", target: rendered };
}
