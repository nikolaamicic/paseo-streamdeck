import {
  agentKey,
  freezeRecord,
  recordsEqual,
  type AgentAddress,
  type AgentRecord,
} from "./agent-model.ts";

export type DirectoryChange =
  | { readonly kind: "added"; readonly key: string; readonly record: AgentRecord }
  | {
      readonly kind: "updated";
      readonly key: string;
      readonly record: AgentRecord;
      readonly previous: AgentRecord;
    }
  | { readonly kind: "removed"; readonly key: string; readonly previous: AgentRecord };

export interface UpsertOptions {
  /**
   * Keep the already known project when the update carries no project
   * placement (Paseo agent updates may omit it).
   */
  readonly preserveProject?: boolean;
}

/**
 * Current set of known agents keyed by identity. It reports only real
 * changes, so consumers re-render exactly the affected items. Records are
 * stored as frozen copies. Positions on the device are not decided here; the
 * navigation layer owns layout stability.
 */
export class AgentDirectory {
  private readonly records = new Map<string, AgentRecord>();

  get size(): number {
    return this.records.size;
  }

  get(address: AgentAddress): AgentRecord | undefined {
    return this.records.get(agentKey(address));
  }

  /** A new array on every call, in snapshot/insertion order. */
  list(): AgentRecord[] {
    return [...this.records.values()];
  }

  /**
   * Reconciles against a full snapshot (initial load or after reconnect):
   * agents missing from the snapshot are removed, others added or updated.
   * If an identity appears twice, the later entry wins.
   */
  replaceAll(snapshot: readonly AgentRecord[]): DirectoryChange[] {
    const next = new Map<string, AgentRecord>();
    for (const record of snapshot) next.set(agentKey(record.address), freezeRecord(record));

    const changes: DirectoryChange[] = [];
    for (const [key, previous] of this.records) {
      if (!next.has(key)) changes.push({ kind: "removed", key, previous });
    }
    for (const [key, record] of next) {
      const change = this.diff(key, record);
      if (change) changes.push(change);
    }

    this.records.clear();
    for (const [key, record] of next) this.records.set(key, record);
    return changes;
  }

  upsert(record: AgentRecord, options: UpsertOptions = {}): DirectoryChange | null {
    const key = agentKey(record.address);
    const previous = this.records.get(key);
    const merged =
      options.preserveProject === true && previous
        ? { ...record, project: previous.project }
        : record;
    const change = this.diff(key, freezeRecord(merged));
    if (change && change.kind !== "removed") this.records.set(key, change.record);
    return change;
  }

  remove(address: AgentAddress): DirectoryChange | null {
    const key = agentKey(address);
    const previous = this.records.get(key);
    if (!previous) return null;
    this.records.delete(key);
    return { kind: "removed", key, previous };
  }

  private diff(key: string, record: AgentRecord): DirectoryChange | null {
    const previous = this.records.get(key);
    if (!previous) return { kind: "added", key, record };
    if (recordsEqual(previous, record)) return null;
    return { kind: "updated", key, record, previous };
  }
}
