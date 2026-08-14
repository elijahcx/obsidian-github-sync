import { SYNC_DEBOUNCE_MS } from "../constants";
import { GitSync } from "./git-sync";
import { SyncResult, SyncStatus } from "../types";
import { normalizeGitPath } from "./paths";

type StatusCallback = (status: SyncStatus, detail?: string) => void;

export class SyncQueue {
  private pendingFiles = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private activeFlush: Promise<SyncResult | null> | null = null;
  private gitSync: GitSync;
  private onStatus: StatusCallback;
  private debounceMs: number;

  constructor(
    gitSync: GitSync,
    onStatus: StatusCallback,
    debounceMs: number = SYNC_DEBOUNCE_MS
  ) {
    this.gitSync = gitSync;
    this.onStatus = onStatus;
    this.debounceMs = debounceMs;
  }

  /** Enqueue a changed file path. Debounces before triggering sync. */
  enqueue(filepath: string): void {
    this.pendingFiles.add(normalizeGitPath(filepath));
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.scheduleFlush();
  }

  /** Update the debounce window, rescheduling any pending flush from now. */
  setDebounceMs(debounceMs: number): void {
    this.debounceMs = debounceMs;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.scheduleFlush();
    }
  }

  getDebounceMs(): number {
    return this.debounceMs;
  }

  private scheduleFlush(): void {
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** Immediately drain the queue (used on vault close). */
  async flushNow(): Promise<SyncResult | null> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.activeFlush) return this.activeFlush;
    return this.flush();
  }

  /** Coordinate plugin unload without launching work beside an active flush. */
  async shutdown(timeoutMs = 10_000): Promise<SyncResult | null> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const drain = async () => {
      if (this.activeFlush) await this.activeFlush;
      return this.flush();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SyncResult>((resolve) => {
      timer = setTimeout(() => resolve({
        success: false,
        conflictFiles: [],
        error: "Sync is still running during plugin unload; full reconciliation is required on next startup.",
      }), timeoutMs);
    });
    const result = await Promise.race([drain(), timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  private async flush(): Promise<SyncResult | null> {
    if (this.activeFlush) return this.activeFlush;
    if (this.pendingFiles.size === 0) return null;

    this.activeFlush = this.flushBatch();
    try {
      return await this.activeFlush;
    } finally {
      this.activeFlush = null;
    }
  }

  private async flushBatch(): Promise<SyncResult> {

    let batchFailed = false;
    const filesToSync = [...this.pendingFiles];
    this.pendingFiles.clear();

    try {
      this.onStatus("pushing");
      const result = await this.gitSync.sync(filesToSync);

      if (result.conflictFiles.length > 0) {
        this.onStatus("conflict");
      } else if (result.success) {
        this.onStatus("idle");
      } else {
        batchFailed = true;
        for (const file of filesToSync) this.pendingFiles.add(file);
        this.onStatus("error", result.error);
      }

      return result;
    } catch (err) {
      batchFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      for (const file of filesToSync) this.pendingFiles.add(file);
      this.onStatus("error", msg);
      return { success: false, conflictFiles: [], error: msg };
    } finally {
      // If more files arrived while we were syncing, flush again
      // New events arriving during a successful/conflicted batch are drained.
      // Failed batches stay pending but require a later event, manual flush, or
      // unload flush to retry, avoiding an infinite offline retry loop.
      if (this.pendingFiles.size > 0 && !batchFailed) {
        setTimeout(() => this.flush(), 500);
      }
    }
  }

  /** Test/diagnostic visibility; pending failures are intentionally retained. */
  getPendingFiles(): string[] {
    return [...this.pendingFiles];
  }
}
