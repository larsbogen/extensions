type SyncEntity = {
  id: string;
  is_deleted?: boolean | number;
  is_archived?: boolean | number;
  checked?: boolean | number;
};

/** Sync responses may include unrelated changes, in any order, and deletion tombstones. */
export function mergeSyncEntities<T extends SyncEntity>(previous: T[], incoming: T[], fullSync = false): T[] {
  const byId = new Map((fullSync ? [] : previous).map((entity) => [entity.id, entity]));
  for (const entity of incoming) {
    if (entity.is_deleted || entity.is_archived || entity.checked) {
      byId.delete(entity.id);
    } else {
      byId.set(entity.id, entity);
    }
  }
  return [...byId.values()];
}
