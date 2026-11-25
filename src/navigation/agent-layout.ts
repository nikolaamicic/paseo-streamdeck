import { agentKey, type AgentAddress, type AgentRecord } from "../agents/agent-model.ts";
import { toDisplayStatus, type DisplayStatus } from "../agents/display-status.ts";

/** Keys per page on Stream Deck + (4 columns × 2 rows). */
export const SLOTS_PER_PAGE = 8;

/** Spec §6 rule 1: waiting → error → running → finished → idle → closed → unknown. */
const PRIORITY: Readonly<Record<DisplayStatus, number>> = {
  awaiting_answer: 0,
  awaiting_permission: 0,
  error: 1,
  starting: 2,
  running: 2,
  turn_ended: 3,
  idle: 4,
  closed: 5,
  unknown: 6,
};

/** Priority, then most recently updated, then agent ID, so the order is total. */
export function compareAgents(a: AgentRecord, b: AgentRecord): number {
  const byPriority = PRIORITY[toDisplayStatus(a)] - PRIORITY[toDisplayStatus(b)];
  if (byPriority !== 0) return byPriority;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.address.agentId === b.address.agentId) return 0;
  return a.address.agentId < b.address.agentId ? -1 : 1;
}

/**
 * Positions of the agents on the keys (spec §6). `arrange` sorts once; later
 * `update`s keep every agent where it is: status changes move nothing, an
 * agent that no longer matches stays in place (shown dimmed, rule 6), an
 * agent that is gone leaves a hole, a new matching agent is appended at the
 * end and trailing holes are trimmed. Only an explicit `arrange` (first data, a confirmed
 * workspace, a refresh press, a host change) reorders, so an agent is never
 * moved under a finger by a status change.
 */
export class AgentLayout {
  private positions: (AgentAddress | null)[] = [];

  /** Number of positions, holes included; page count follows from it. */
  get size(): number {
    return this.positions.length;
  }

  /** Agents placed, without holes. */
  get agentCount(): number {
    return this.positions.filter((address) => address !== null).length;
  }

  get pageCount(): number {
    return Math.max(1, Math.ceil(this.positions.length / SLOTS_PER_PAGE));
  }

  at(index: number): AgentAddress | null {
    return this.positions[index] ?? null;
  }

  arrange(agents: readonly AgentRecord[]): void {
    this.positions = [...agents].sort(compareAgents).map((agent) => agent.address);
  }

  /**
   * Applies the current agents without reordering: `matching` are the agents
   * of the shown selection, `present` all agents of the host. Returns true
   * when positions changed.
   */
  update(matching: readonly AgentRecord[], present: readonly AgentRecord[]): boolean {
    const existing = new Set(present.map((agent) => agentKey(agent.address)));
    const placed = new Set<string>();
    let changed = false;
    const next = this.positions.map((address) => {
      if (address === null) return null;
      const key = agentKey(address);
      if (!existing.has(key)) {
        changed = true;
        return null;
      }
      placed.add(key);
      return address;
    });
    const added = matching
      .filter((agent) => !placed.has(agentKey(agent.address)))
      .sort(compareAgents)
      .map((agent) => agent.address);
    if (added.length > 0) changed = true;
    next.push(...added);
    while (next.length > 0 && next[next.length - 1] === null) {
      next.pop();
      changed = true;
    }
    this.positions = next;
    return changed;
  }
}
