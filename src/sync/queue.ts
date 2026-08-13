import { SYNC_DEBOUNCE_MS } from "../constants";
import { GitSync } from "./git-sync";
import { SyncResult, SyncStatus } from "../types";
import { normalizeGitPath } from "./paths";

type StatusCallback = (status: SyncStatus, detail?: string) => void;

export class SyncQueue {
  private pendingFiles = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
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
    return this.flush();
  }

  private async flush(): Promise<SyncResult | null> {
    if (this.running || this.pendingFiles.size === 0) return null;

    this.running = true;
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
        this.onStatus("error", result.error);
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onStatus("error", msg);
      return { success: false, conflictFiles: [], error: msg };
    } finally {
      this.running = false;
      // If more files arrived while we were syncing, flush again
      if (this.pendingFiles.size > 0) {
        setTimeout(() => this.flush(), 500);
      }
    }
  }
}
