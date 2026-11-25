import {
  freezeWorkspace,
  workspaceKey,
  workspacesEqual,
  type WorkspaceAddress,
  type WorkspaceRecord,
} from "./workspace-model.ts";

export type WorkspaceChange =
  | { readonly kind: "added"; readonly key: string; readonly record: WorkspaceRecord }
  | {
      readonly kind: "updated";
      readonly key: string;
      readonly record: WorkspaceRecord;
      readonly previous: WorkspaceRecord;
    }
  | { readonly kind: "removed"; readonly key: string; readonly previous: WorkspaceRecord };

/**
 * Current set of known workspaces keyed by identity. Reports only real
 * changes and stores frozen copies. Ordering for dial 3 and labels for the
 * touch strip are decided elsewhere.
 */
export class WorkspaceDirectory {
  private readonly records = new Map<string, WorkspaceRecord>();

  get size(): number {
    return this.records.size;
  }

  get(address: WorkspaceAddress): WorkspaceRecord | undefined {
    return this.records.get(workspaceKey(address));
  }

  /** A new array on every call, in snapshot/insertion order. */
  list(): WorkspaceRecord[] {
    return [...this.records.values()];
  }

  /**
   * Reconciles against a full snapshot: workspaces missing from it are
   * removed, others added or updated. If an identity appears twice, the later
   * entry wins.
   */
  replaceAll(snapshot: readonly WorkspaceRecord[]): WorkspaceChange[] {
    const next = new Map<string, WorkspaceRecord>();
    for (const record of snapshot) next.set(workspaceKey(record.address), freezeWorkspace(record));

    const changes: WorkspaceChange[] = [];
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

  upsert(record: WorkspaceRecord): WorkspaceChange | null {
    const key = workspaceKey(record.address);
    const change = this.diff(key, freezeWorkspace(record));
    if (change && change.kind !== "removed") this.records.set(key, change.record);
    return change;
  }

  remove(address: WorkspaceAddress): WorkspaceChange | null {
    const key = workspaceKey(address);
    const previous = this.records.get(key);
    if (!previous) return null;
    this.records.delete(key);
    return { kind: "removed", key, previous };
  }

  private diff(key: string, record: WorkspaceRecord): WorkspaceChange | null {
    const previous = this.records.get(key);
    if (!previous) return { kind: "added", key, record };
    if (workspacesEqual(previous, record)) return null;
    return { kind: "updated", key, record, previous };
  }
}
