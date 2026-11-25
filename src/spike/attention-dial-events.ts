import type { AgentAddress } from "../agents/agent-model.ts";
import type { OpenOutcome } from "../opener/open-agent.ts";
import type { AttentionDialHandle, AttentionDials } from "./attention-dial.ts";

/**
 * The Attention dial's SDK events (M11b2b2), moved from plugin.ts
 * unchanged: the shutdown guard on appear and the press flow around the
 * opener. The existing AttentionDials keeps the dials, their strips and the
 * press guard; this only orchestrates the events. The SDK action class
 * only checks the SDK kind (isDial) and calls it. Nothing here imports the
 * Stream Deck SDK.
 */

/** The action instance of a press. */
export interface AttentionPressInput {
  readonly id: string;
  showAlert(): Promise<void>;
}

export interface AttentionDialEventsDeps {
  readonly dials: AttentionDials;
  /** After shutdown began no dial appears. */
  readonly shutdownStarted: () => boolean;
  readonly open: (address: AgentAddress) => Promise<OpenOutcome>;
  /** Fixed codes only. */
  readonly log: (message: string) => void;
}

export class AttentionDialEvents {
  private readonly deps: AttentionDialEventsDeps;

  constructor(deps: AttentionDialEventsDeps) {
    this.deps = deps;
  }

  appeared(handle: AttentionDialHandle): void {
    if (this.deps.shutdownStarted()) return;
    this.deps.dials.appear(handle);
  }

  disappeared(contextId: string): void {
    this.deps.dials.disappear(contextId);
  }

  rotated(contextId: string, ticks: number): void {
    this.deps.dials.rotate(contextId, ticks);
  }

  /** Opens the agent on the accepted strip; feedback only after the outcome. */
  async pressed(input: AttentionPressInput): Promise<void> {
    const press = this.deps.dials.press(input.id);
    if (press.kind === "none") return;
    if (press.kind === "refused") {
      this.deps.log("attention dial: press_refused");
      await input.showAlert();
      return;
    }
    const outcome = await this.deps.open(press.address);
    this.deps.log(`attention dial: open_${outcome}`);
    // Dials have no showOk in the SDK; only a failure is signalled.
    if (outcome !== "requested") await input.showAlert();
  }
}
