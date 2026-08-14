import { ConflictFile, SyncResult } from "../types";

export type SyncResultClassification =
  | { kind: "conflict"; conflicts: ConflictFile[] }
  | { kind: "success" }
  | { kind: "error"; message: string };

/**
 * Give conflict payloads precedence over the success flag. A conflict is an
 * expected, user-owned workflow, not a generic failed sync.
 */
export function classifySyncResult(result: SyncResult): SyncResultClassification {
  if (!Array.isArray(result.conflictFiles)) {
    return { kind: "error", message: "Sync failed: invalid result did not include conflict details." };
  }
  if (result.conflictFiles.length > 0) {
    return { kind: "conflict", conflicts: result.conflictFiles };
  }
  if (result.success === true) return { kind: "success" };
  if (result.success === false && typeof result.error === "string" && result.error.trim()) {
    return { kind: "error", message: result.error };
  }
  return { kind: "error", message: "Sync failed: no error details were returned." };
}
