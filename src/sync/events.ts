import { normalizeGitPath } from "./paths";

export interface FileChangeQueue {
  enqueue(filepath: string): void;
}

/** Queue both sides of a rename so Git can remove the old path and add the new one. */
export function enqueueRename(
  queue: FileChangeQueue,
  oldPath: string,
  newPath: string,
  isExcluded: (filepath: string) => boolean
): void {
  const oldGitPath = normalizeGitPath(oldPath);
  const newGitPath = normalizeGitPath(newPath);
  if (!isExcluded(oldGitPath)) queue.enqueue(oldGitPath);
  if (!isExcluded(newGitPath)) queue.enqueue(newGitPath);
}

/** Queue a deletion only when the deleted path participates in synchronization. */
export function enqueueDelete(
  queue: FileChangeQueue,
  filepath: string,
  isExcluded: (filepath: string) => boolean
): void {
  const gitPath = normalizeGitPath(filepath);
  if (!isExcluded(gitPath)) queue.enqueue(gitPath);
}
