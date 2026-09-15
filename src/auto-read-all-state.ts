const completeSnapshots = new Map<string, string>();
export function recordAutoReadAllComplete(absolutePath: string, snapshotId: string): void {
  completeSnapshots.set(absolutePath, snapshotId);
}
export function getAutoReadAllSnapshot(absolutePath: string): string | undefined {
  return completeSnapshots.get(absolutePath);
}
export function invalidateAutoReadAllComplete(absolutePath: string): void {
  completeSnapshots.delete(absolutePath);
}
export function clearAutoReadAllComplete(): void {
  completeSnapshots.clear();
}
