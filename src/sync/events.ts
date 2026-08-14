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

/** Queue a folder rename plus every currently materialized child file. */
export function enqueueFolderRename(
  queue: FileChangeQueue,
  oldPath: string,
  newPath: string,
  newChildPaths: string[],
  isExcluded: (filepath: string) => boolean
): void {
  enqueueRename(queue, oldPath, newPath, isExcluded);
  const normalizedNew = normalizeGitPath(newPath);
  const normalizedOld = normalizeGitPath(oldPath);
  for (const childInput of newChildPaths) {
    const child = normalizeGitPath(childInput);
    const suffix = child.startsWith(`${normalizedNew}/`)
      ? child.slice(normalizedNew.length + 1)
      : child;
    enqueueRename(queue, `${normalizedOld}/${suffix}`, child, isExcluded);
  }
}

/** A missing folder path is expanded to tracked descendants by GitSync. */
export function enqueueFolderDelete(
  queue: FileChangeQueue,
  folderPath: string,
  isExcluded: (filepath: string) => boolean
): void {
  enqueueDelete(queue, folderPath, isExcluded);
}
