import { SyncChangeCounts, SyncResult } from "../types";
import { classifySyncResult } from "./result-classification";

export function formatSyncSummary(changes?: SyncChangeCounts): string {
  if (!changes) return "Synced successfully";
  const parts = (["added", "updated", "removed"] as const)
    .filter((category) => changes[category] > 0)
    .map((category) => `${changes[category]} ${category}`);
  return parts.length === 0 ? "Already up to date" : `Synced — ${parts.join(", ")}`;
}

export interface ManualSyncActions {
  conflict(conflicts: SyncResult["conflictFiles"]): void;
  success(message: string): void;
  error(message: string, logs?: string[]): void;
}

/** Routes only user-triggered sync results to their appropriate UI. */
export function presentManualSyncResult(result: SyncResult, actions: ManualSyncActions): "conflict" | "success" | "error" {
  const outcome = classifySyncResult(result);
  if (outcome.kind === "conflict") {
    actions.conflict(outcome.conflicts);
    return "conflict";
  }
  if (outcome.kind === "error") {
    actions.error(outcome.message, result.logs);
    return "error";
  }
  actions.success(formatSyncSummary(result.changes));
  return "success";
}
