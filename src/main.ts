import { Plugin, Notice, TFile, TFolder, TAbstractFile, Modal } from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS, SyncStatus, ConflictFile } from "./types";
import { MultiSyncSettingsTab } from "./ui/settings-tab";
import { StatusBarItem } from "./ui/status-bar";
import { ConflictModal } from "./ui/conflict-modal";
import { GitSync } from "./sync/git-sync";
import { SyncQueue } from "./sync/queue";
import { enqueueDelete, enqueueFolderDelete, enqueueFolderRename, enqueueRename } from "./sync/events";
import { normalizeGitPath } from "./sync/paths";
import { persistResolutionMetadata } from "./sync/resolution-completion";
import { repoExists, createRepo, vaultNameToRepoName } from "./github/api";
import { REMOTE_POLL_INTERVAL_MS } from "./constants";
import { RemotePoller } from "./sync/remote-poller";
import { DiagnosticsModal } from "./ui/diagnostics-modal";
import { EMPTY_POLL_DIAGNOSTICS, EMPTY_QUEUE_DIAGNOSTICS, SyncDiagnostics } from "./diagnostics";
import { classifySyncResult } from "./sync/result-classification";

export default class MultiSyncPlugin extends Plugin {
  settings!: PluginSettings;
  private statusBar!: StatusBarItem;
  private gitSync: GitSync | null = null;
  private syncQueue: SyncQueue | null = null;
  private remotePoller: RemotePoller | null = null;
  private unloading = false;
  private foregroundOperations = 0;
  private conflictActive = false;
  private activeConflicts: ConflictFile[] | null = null;
  private conflictModalOpen = false;
  private currentStatus: SyncStatus = "idle";
  private lastSuccessfulSyncAt: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.lastSuccessfulSyncAt = this.settings.lastSyncTime || null;

    this.statusBar = new StatusBarItem(this);
    this.statusBar.onClick(() => this.handleStatusBarClick());

    this.addSettingTab(new MultiSyncSettingsTab(this.app, this));

    // Keyboard command
    this.addCommand({
      id: "sync-now",
      name: "Sync vault now",
      callback: () => this.triggerManualSync(),
    });
    this.addCommand({
      id: "show-sync-diagnostics",
      name: "Show sync diagnostics",
      callback: () => new DiagnosticsModal(this.app, this.getDiagnostics()).open(),
    });

    // Boot sync engine if already connected
    if (
      this.settings.githubToken &&
      this.settings.githubUsername &&
      this.settings.repoName
    ) {
      await this.bootSyncEngine();
    }

    // Pull on open — wait for workspace to be ready
    this.app.workspace.onLayoutReady(async () => {
      if (this.gitSync) {
        this.foregroundOperations++;
        this.setStatus("pulling");
        try {
          const conflicts = await this.gitSync.pull();
          if (conflicts.length > 0) {
            this.presentConflicts(conflicts);
          } else {
            this.markSuccessfulSync(false);
            this.setStatus("idle");
          }
        } catch {
          // Pull errors on open are non-fatal (e.g. offline) — just show error state
          this.setStatus("error", "Pull failed on open");
        } finally {
          this.foregroundOperations--;
        }
      }
    });

    // Watch file changes for auto-sync
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!this.syncQueue || !this.settings.autoSync) return;
        if (this.isExcluded(file.path)) return;
        this.syncQueue.enqueue(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!this.syncQueue || !this.settings.autoSync) return;
        if (this.isExcluded(file.path)) return;
        this.syncQueue.enqueue(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (!this.syncQueue || !this.settings.autoSync) return;
        if (file instanceof TFile) {
          enqueueDelete(this.syncQueue, file.path, (path) => this.isExcluded(path));
        } else if (file instanceof TFolder) {
          enqueueFolderDelete(this.syncQueue, file.path, (path) => this.isExcluded(path));
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (!this.syncQueue || !this.settings.autoSync) return;
        if (file instanceof TFile) {
          enqueueRename(this.syncQueue, oldPath, file.path, (path) => this.isExcluded(path));
        } else if (file instanceof TFolder) {
          enqueueFolderRename(
            this.syncQueue,
            oldPath,
            file.path,
            this.filesInFolder(file),
            (path) => this.isExcluded(path)
          );
        }
      })
    );
  }

  private filesInFolder(folder: TFolder): string[] {
    const paths: string[] = [];
    const visit = (current: TFolder): void => {
      for (const child of current.children) {
        if (child instanceof TFile) paths.push(child.path);
        else if (child instanceof TFolder) visit(child);
      }
    };
    visit(folder);
    return paths;
  }

  async onunload(): Promise<void> {
    // Stop future callbacks before queue shutdown. A pull already holding the
    // GitSync mutex is allowed to finish, matching the queue's shutdown model.
    this.unloading = true;
    this.stopRemotePolling();
    // Flush pending changes on close
    if (this.syncQueue) {
      await this.syncQueue.shutdown();
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  setStatus(status: SyncStatus, detail?: string): void {
    this.currentStatus = status;
    this.statusBar.set(status, detail);
    this.refreshDiagnostics();
  }

  /**
   * Called after the user connects their GitHub account.
   * Determines whether to clone (existing repo) or init+push (new repo).
   */
  async initializeRepo(token: string, username: string): Promise<void> {
    this.foregroundOperations++;
    this.stopRemotePolling();
    this.setStatus("connecting");

    const vaultName = this.app.vault.getName();
    // Prefer the user-supplied repo name; fall back to a slug of the vault name.
    const repoName = this.settings.repoName || vaultNameToRepoName(vaultName);
    this.settings.repoName = repoName;

    const adapter = this.app.vault.adapter;
    // Obsidian exposes basePath on FileSystemAdapter (desktop). On mobile the vault
    // root is the adapter itself, so we fall back to an empty string which causes
    // isomorphic-git to use relative paths from the adapter root.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultPath: string = (adapter as any).basePath ?? "";

    const sync = new GitSync(adapter, vaultPath, token, username, repoName, (p) =>
      this.isExcluded(p)
    );

    try {
      const exists      = await repoExists(token, username, repoName);
      const alreadyInit = await sync.isInitialized();

    const allFiles = () =>
      this.app.vault
        .getFiles()
        .map((f) => f.path)
        .filter((p) => !this.isExcluded(p));

    if (!exists) {
      // Brand-new vault — create repo and push everything
      await createRepo(token, repoName, `Obsidian vault: ${vaultName}`);
      await sync.initAndPush(allFiles());
      new Notice(`Created private repo: ${username}/${repoName}`);
    } else if (!alreadyInit) {
      // Repo exists remotely, this is a new device — clone it.
      // clone() returns false when the remote is empty (a previous initAndPush
      // created the repo but never pushed any commits). In that case fall back
      // to initAndPush so we establish the local branch and push.
      const cloneHadCommits = await sync.clone();
      if (!cloneHadCommits) {
        await sync.initAndPush(allFiles());
        new Notice(`Initialised repo: ${username}/${repoName}`);
      } else {
        new Notice(`Cloned repo: ${username}/${repoName}`);
      }
    } else {
      // Already initialised locally — ensure remote URL is current, then reconnect.
      // Also handles the case where a previous push was interrupted (local branch
      // exists but remote is empty): ensureLocalBranch will push on next sync.
      new Notice(`Reconnected to: ${username}/${repoName}`);
    }

    this.markSuccessfulSync();
    await this.saveSettings();
    await this.bootSyncEngine();
    this.setStatus("idle");
    } finally {
      this.foregroundOperations--;
      this.updateRemotePolling();
    }
  }

  async bootSyncEngine(): Promise<void> {
    const { githubToken, githubUsername, repoName } = this.settings;
    if (!githubToken || !githubUsername || !repoName) return;

    this.stopRemotePolling();
    const adapter = this.app.vault.adapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultPath: string = (adapter as any).basePath ?? "";

    this.gitSync = new GitSync(
      adapter,
      vaultPath,
      githubToken,
      githubUsername,
      repoName,
      (p) => this.isExcluded(p)
    );

    this.syncQueue = new SyncQueue(this.gitSync, (status, detail) => {
      this.setStatus(status, detail);
      if (status === "idle") {
        this.markSuccessfulSync();
        this.saveSettings();
      }
    }, this.settings.syncIntervalMs, () => this.refreshDiagnostics(),
    (conflicts) => this.presentConflicts(conflicts));
    this.updateRemotePolling();
  }

  updateAutoSync(enabled: boolean): void {
    this.settings.autoSync = enabled;
    this.updateRemotePolling();
  }

  disconnectSyncEngine(): void {
    this.stopRemotePolling();
    this.gitSync = null;
    this.syncQueue = null;
  }

  private updateRemotePolling(): void {
    if (!this.settings.autoSync || !this.gitSync || this.unloading) {
      this.stopRemotePolling();
      return;
    }
    if (!this.remotePoller) {
      this.remotePoller = new RemotePoller(
        REMOTE_POLL_INTERVAL_MS,
        (callback, intervalMs) => {
          const timer = window.setInterval(callback, intervalMs);
          this.registerInterval(timer);
          return timer;
        },
        (timer) => window.clearInterval(timer),
        () => {
          if (this.conflictActive || this.syncQueue?.getDiagnostics().conflictPaused) return "skipped-conflict";
          if (this.foregroundOperations > 0) return "skipped-foreground-operation";
          if (!this.syncQueue?.isIdleForRemotePull()) return "skipped-local-work";
          return null;
        },
        () => this.pollRemote(),
        (error) => console.debug("[git-sync] Passive remote poll failed; will retry", error),
        () => this.refreshDiagnostics()
      );
    }
    this.remotePoller.start();
  }

  private stopRemotePolling(): void {
    this.remotePoller?.stop();
  }

  private async pollRemote(): Promise<"success" | "skipped-conflict"> {
    const sync = this.gitSync;
    if (!sync) return "success";
    const conflicts = await sync.pull();
    if (this.unloading || sync !== this.gitSync) return "success";
    if (conflicts.length > 0) {
      this.presentConflicts(conflicts);
      return "skipped-conflict";
    } else {
      this.markSuccessfulSync(false);
      return "success";
    }
  }

  updateSyncIntervalMs(debounceMs: number): void {
    this.syncQueue?.setDebounceMs(debounceMs);
  }

  async triggerManualSync(): Promise<void> {
    if (!this.gitSync) {
      new Notice(
        "Git Sync Vault: not connected. Please connect your GitHub account in settings."
      );
      return;
    }

    // An unresolved session owns synchronization. Manual sync must not discard
    // it or put another conflict modal underneath the active one.
    if (this.activeConflicts) {
      this.presentConflicts(this.activeConflicts);
      return;
    }

    this.foregroundOperations++;
    this.setStatus("pulling");
    try {
      const allFiles = this.app.vault
        .getFiles()
        .map((f) => f.path)
        .filter((p) => !this.isExcluded(p));

      const result = await this.gitSync.syncAll(allFiles);
      const outcome = classifySyncResult(result);

      // A conflict owns the UI until it is resolved or abandoned. In
      // particular, do not leave a generic debug/error modal behind it for the
      // same conflict-bearing result.
      if (outcome.kind === "conflict") {
        this.presentConflicts(outcome.conflicts);
      } else if (outcome.kind === "success") {
        if (result.logs?.length) showLogModal(this.app, "Sync OK", result.logs);
        this.syncQueue?.resumeAfterConflict();
        this.markSuccessfulSync();
        await this.saveSettings();
        this.setStatus("idle");
        new Notice("Vault synced successfully.");
      } else {
        if (result.logs?.length) showLogModal(this.app, `Sync error: ${outcome.message}`, result.logs);
        this.setStatus("error", outcome.message);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
      new Notice(`Sync failed: ${msg}`);
    } finally {
      this.foregroundOperations--;
    }
  }

  private handleStatusBarClick(): void {
    if (this.activeConflicts) this.presentConflicts(this.activeConflicts);
    else void this.triggerManualSync();
  }

  /** The single owner for conflict state and presentation from every sync source. */
  private presentConflicts(conflicts: ConflictFile[]): void {
    if (conflicts.length === 0) return;
    const sessionId = conflicts[0].conflictSessionId;
    const activeSessionId = this.activeConflicts?.[0]?.conflictSessionId;
    if (activeSessionId !== sessionId) this.activeConflicts = conflicts;
    this.conflictActive = true;
    this.syncQueue?.pauseForConflict();
    this.setStatus("conflict");
    if (this.conflictModalOpen) return;
    this.conflictModalOpen = true;

    new ConflictModal(
      this.app,
      this.activeConflicts!,
      async (filepath, resolved, conflictSessionId) => {
        // Returns true only once EVERY conflict is decided and the merge landed.
        const result = await this.gitSync!.resolveConflict(filepath, resolved, conflictSessionId);
        if (result.stale) {
          this.conflictActive = false;
          this.activeConflicts = null;
          this.setStatus("error", result.message);
          new Notice(result.message ?? "Conflict is stale. Please sync again.");
          this.syncQueue?.resumeAfterConflict();
          return "rejected";
        }
        if (result.message && !result.completed) {
          new Notice(result.message);
          return "rejected";
        }
        if (result.conflictFiles?.length) {
          this.activeConflicts = result.conflictFiles;
          this.conflictModalOpen = false;
          // Let this modal close before presenting the replacement session.
          window.setTimeout(() => this.presentConflicts(result.conflictFiles!), 0);
          return "replaced";
        }
        if (result.completed) {
          this.conflictActive = false;
          this.activeConflicts = null;
          this.conflictModalOpen = false;
          this.markSuccessfulSync();
          this.setStatus("idle");
          new Notice("Conflicts resolved — vault synced.");
          this.syncQueue?.resumeAfterConflict();
          await persistResolutionMetadata(() => this.saveSettings(), (error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[git-sync] Conflict resolved, but settings could not be saved: ${message}`);
            new Notice(`Vault synced, but sync time could not be saved: ${message}`);
          });
        }
        return "accepted";
      },
      () => {
        // X/Esc intentionally leaves the pending session and queue pause intact.
        // Clicking the conflict status item (or Sync now) reopens this session.
        this.conflictModalOpen = false;
        if (this.activeConflicts) this.setStatus("conflict");
      }
    ).open();
  }

  private isExcluded(filepath: string): boolean {
    filepath = normalizeGitPath(filepath);
    return this.settings.excludePatterns.some((pattern) => {
      // Convert simple glob pattern (supports *) to regex
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const regexStr = escaped.replace(/\*/g, ".*");
      return new RegExp(`^${regexStr}$`).test(filepath);
    });
  }

  getDiagnostics(): SyncDiagnostics {
    return {
      version: this.manifest.version,
      status: this.currentStatus,
      connected: !!(this.gitSync && this.settings.githubUsername && this.settings.repoName),
      githubUsername: this.settings.githubUsername,
      repoName: this.settings.repoName,
      autoSync: this.settings.autoSync,
      debounceMs: this.settings.syncIntervalMs,
      remoteIntervalMs: REMOTE_POLL_INTERVAL_MS,
      lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      queue: this.syncQueue?.getDiagnostics() ?? { ...EMPTY_QUEUE_DIAGNOSTICS },
      polling: this.remotePoller?.getDiagnostics() ?? { ...EMPTY_POLL_DIAGNOSTICS },
    };
  }

  private markSuccessfulSync(persist = true): void {
    this.lastSuccessfulSyncAt = Date.now();
    if (persist) this.settings.lastSyncTime = this.lastSuccessfulSyncAt;
    this.refreshDiagnostics();
  }

  private refreshDiagnostics(): void {
    if (!this.unloading && this.statusBar) this.statusBar.setDiagnostics(this.getDiagnostics());
  }
}

/**
 * DEBUG helper: show a scrollable log trace on-screen. Used because mobile has
 * no reachable dev console. Includes a Copy button so the trace can be shared.
 */
function showLogModal(app: import("obsidian").App, header: string, logs: string[]): void {
  const modal = new Modal(app);
  modal.titleEl.setText(header);
  const body = logs.join("\n");

  const pre = modal.contentEl.createEl("pre");
  pre.style.cssText =
    "white-space:pre-wrap;word-break:break-all;font-family:monospace;" +
    "font-size:12px;max-height:60vh;overflow:auto;user-select:text;" +
    "background:var(--background-secondary);padding:8px;border-radius:6px;";
  pre.setText(body);

  const btn = modal.contentEl.createEl("button", { text: "Copy" });
  btn.style.marginTop = "8px";
  btn.onclick = () => {
    navigator.clipboard?.writeText(body);
    new Notice("Log copied.");
  };

  modal.open();
}
