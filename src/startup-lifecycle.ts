import { FileSystemAdapter, type DataAdapter } from "obsidian";

/** Run startup reconciliation before enabling file-event reactions. */
export async function activateAfterStartupReconciliation(
  reconcile: () => Promise<void>,
  activate: () => void
): Promise<void> {
  try {
    await reconcile();
  } finally {
    activate();
  }
}

/**
 * The DataAdapter bridge is required for mobile-compatible vault I/O. Desktop
 * supplies an absolute root through FileSystemAdapter; mobile adapters operate
 * relative to their own root and must never be cast to FileSystemAdapter.
 */
export function vaultPathForAdapter(adapter: DataAdapter): string {
  return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
}
