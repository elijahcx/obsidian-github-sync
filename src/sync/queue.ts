import { SYNC_DEBOUNCE_MS } from "../constants";
import { GitSync } from "./git-sync";
import { SyncResult, SyncStatus } from "../types";
import { normalizeGitPath } from "./paths";

type StatusCallback = (status: SyncStatus, detail?: string) => void;

export class SyncQueue {
  private pendingFiles = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private activeFlush: Promise<SyncResult | null> | null = null;
  private conflictPaused = false;
  private shuttingDown = false;
  private shutdownPromise: Promise<SyncResult | null> | null = null;
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
    if (this.shuttingDown || this.conflictPaused) return;
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
    if (this.shuttingDown || this.conflictPaused) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** Immediately drain the queue (used on vault close). */
  async flushNow(): Promise<SyncResult | null> {
    if (this.shuttingDown) return null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.activeFlush) return this.activeFlush;
    return this.flush();
  }

  /** Coordinate plugin unload without launching work beside an active flush. */
  async shutdown(timeoutMs = 10_000): Promise<SyncResult | null> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const activeAtShutdown = this.activeFlush;
    this.shutdownPromise = (async () => {
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutResult: SyncResult = {
        success: false,
        conflictFiles: [],
        error: "Sync is still running during plugin unload; full reconciliation is required on next startup.",
      };
      const timeout = new Promise<SyncResult>((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve(timeoutResult); }, timeoutMs);
      });
      if (activeAtShutdown) {
        const activeResult = await Promise.race([activeAtShutdown, timeout]);
        if (timedOut) return activeResult;
      }
      const result = this.pendingFiles.size > 0
        ? await Promise.race([this.flush(true), timeout])
        : activeAtShutdown ? await activeAtShutdown : null;
      if (timer) clearTimeout(timer);
      return result;
    })();
    return this.shutdownPromise;
  }

  private async flush(duringShutdown = false): Promise<SyncResult | null> {
    if (this.shuttingDown && !duringShutdown) return null;
    if (this.conflictPaused && !duringShutdown) return null;
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
      this.emitStatus("pushing");
      const result = await this.gitSync.sync(filesToSync);

      if (result.conflictFiles.length > 0) {
        this.conflictPaused = true;
        this.emitStatus("conflict");
      } else if (result.success) {
        this.emitStatus("idle");
      } else {
        batchFailed = true;
        for (const file of filesToSync) this.pendingFiles.add(file);
        this.emitStatus("error", result.error);
      }

      return result;
    } catch (err) {
      batchFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      for (const file of filesToSync) this.pendingFiles.add(file);
      this.emitStatus("error", msg);
      return { success: false, conflictFiles: [], error: msg };
    } finally {
      // If more files arrived while we were syncing, flush again
      // New events arriving during a successful/conflicted batch are drained.
      // Failed batches stay pending but require a later event, manual flush, or
      // unload flush to retry, avoiding an infinite offline retry loop.
      if (this.pendingFiles.size > 0 && !batchFailed && !this.conflictPaused && !this.shuttingDown) {
        setTimeout(() => this.flush(), 500);
      }
    }
  }

  resumeAfterConflict(): void {
    this.conflictPaused = false;
    if (this.pendingFiles.size > 0 && !this.shuttingDown) this.scheduleFlush();
  }

  pauseForConflict(): void {
    this.conflictPaused = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  supersedeConflictForManualSync(): void {
    this.conflictPaused = false;
  }

  private emitStatus(status: SyncStatus, detail?: string): void {
    if (!this.shuttingDown) this.onStatus(status, detail);
  }

  /** Test/diagnostic visibility; pending failures are intentionally retained. */
  getPendingFiles(): string[] {
    return [...this.pendingFiles];
  }
}
