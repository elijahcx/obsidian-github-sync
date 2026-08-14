import { Plugin, Notice, TFile, TFolder, TAbstractFile, Modal } from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS, SyncStatus, ConflictFile } from "./types";
import { MultiSyncSettingsTab } from "./ui/settings-tab";
import { StatusBarItem } from "./ui/status-bar";
import { ConflictModal } from "./ui/conflict-modal";
import { GitSync } from "./sync/git-sync";
import { SyncQueue } from "./sync/queue";
import { enqueueDelete, enqueueFolderDelete, enqueueFolderRename, enqueueRename } from "./sync/events";
import { normalizeGitPath } from "./sync/paths";
import { repoExists, createRepo, vaultNameToRepoName } from "./github/api";

export default class MultiSyncPlugin extends Plugin {
  settings!: PluginSettings;
  private statusBar!: StatusBarItem;
  private gitSync: GitSync | null = null;
  private syncQueue: SyncQueue | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBar = new StatusBarItem(this);
    this.statusBar.onClick(() => this.triggerManualSync());

    this.addSettingTab(new MultiSyncSettingsTab(this.app, this));

    // Keyboard command
    this.addCommand({
      id: "sync-now",
      name: "Sync vault now",
      callback: () => this.triggerManualSync(),
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
        this.setStatus("pulling");
        try {
          const conflicts = await this.gitSync.pull();
          if (conflicts.length > 0) {
            this.setStatus("conflict");
            this.showConflictModal(conflicts);
          } else {
            this.setStatus("idle");
          }
        } catch {
          // Pull errors on open are non-fatal (e.g. offline) — just show error state
          this.setStatus("error", "Pull failed on open");
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
    this.statusBar.set(status, detail);
  }

  /**
   * Called after the user connects their GitHub account.
   * Determines whether to clone (existing repo) or init+push (new repo).
   */
  async initializeRepo(token: string, username: string): Promise<void> {
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

    this.settings.lastSyncTime = Date.now();
    await this.saveSettings();
    await this.bootSyncEngine();
    this.setStatus("idle");
  }

  async bootSyncEngine(): Promise<void> {
    const { githubToken, githubUsername, repoName } = this.settings;
    if (!githubToken || !githubUsername || !repoName) return;

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
        this.settings.lastSyncTime = Date.now();
        this.saveSettings();
      }
    }, this.settings.syncIntervalMs);
  }

  updateSyncIntervalMs(debounceMs: number): void {
    this.syncQueue?.setDebounceMs(debounceMs);
  }

  async triggerManualSync(): Promise<void> {
    if (!this.gitSync) {
      new Notice(
        "MultiSync: not connected. Please connect your GitHub account in settings."
      );
      return;
    }

    this.setStatus("pulling");
    try {
      const allFiles = this.app.vault
        .getFiles()
        .map((f) => f.path)
        .filter((p) => !this.isExcluded(p));

      const result = await this.gitSync.syncAll(allFiles);

      // DEBUG: show the full step-by-step trace on-screen (mobile has no console).
      if (result.logs && result.logs.length) {
        const header = result.success
          ? "Sync OK"
          : `Sync error: ${result.error ?? "unknown"}`;
        showLogModal(this.app, header, result.logs);
      }

      if (result.conflictFiles.length > 0) {
        this.setStatus("conflict");
        this.showConflictModal(result.conflictFiles);
      } else if (result.success) {
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        this.setStatus("idle");
        new Notice("Vault synced successfully.");
      } else {
        this.setStatus("error", result.error);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
      new Notice(`Sync failed: ${msg}`);
    }
  }

  private showConflictModal(conflicts: ConflictFile[]): void {
    new ConflictModal(
      this.app,
      conflicts,
      async (filepath, resolved, conflictSessionId) => {
        // Returns true only once EVERY conflict is decided and the merge landed.
        const result = await this.gitSync!.resolveConflict(filepath, resolved, conflictSessionId);
        if (result.stale) {
          this.setStatus("error", result.message);
          new Notice(result.message ?? "Conflict is stale. Please sync again.");
          return "rejected";
        }
        if (result.conflictFiles?.length) {
          this.setStatus("conflict");
          this.showConflictModal(result.conflictFiles);
          return "replaced";
        }
        if (result.completed) {
          this.settings.lastSyncTime = Date.now();
          await this.saveSettings();
          this.setStatus("idle");
          new Notice("Conflicts resolved — vault synced.");
        }
        return "accepted";
      },
      () => {
        // Dismissed without deciding everything: drop the pending merge so the
        // repo stays exactly as it was. The next sync will offer it again.
        void this.gitSync?.abandonMerge(conflicts[0].conflictSessionId);
        this.setStatus("idle");
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
