import * as git from "isomorphic-git";
import { requestUrl, DataAdapter } from "obsidian";
import { createFsAdapter } from "./fs-adapter";
import {
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  DEFAULT_BRANCH,
} from "../constants";
import { ConflictChoice, ConflictFile, ConflictResolutionResult, SyncResult } from "../types";
import { isSafeRelativePath, isSafeSnapshotBasename, normalizeGitPath, normalizeVaultPath } from "./paths";

const MAX_PUSH_ATTEMPTS = 3;
let nextConflictSession = 1;
const RECOVERY_SCHEMA_VERSION = 1;
const RECOVERY_DIR = ".git/obsidian-sync-recovery";

type RecoveryJournal = {
  version: 1;
  operationId: string;
  operation: "excluded-working-tree";
  phase: "snapshotted";
  localHead: string;
  remoteHead: string;
  timestamp: string;
  snapshots: Array<{ path: string; existed: boolean; file?: string }>;
};

/** A FIFO mutex shared by every GitSync instance using the same vault adapter. */
class SyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const vaultMutexes = new WeakMap<DataAdapter, Map<string, SyncMutex>>();

function mutexFor(adapter: DataAdapter, vaultPath: string): SyncMutex {
  let adapterMutexes = vaultMutexes.get(adapter);
  if (!adapterMutexes) {
    adapterMutexes = new Map();
    vaultMutexes.set(adapter, adapterMutexes);
  }

  let mutex = adapterMutexes.get(vaultPath);
  if (!mutex) {
    mutex = new SyncMutex();
    adapterMutexes.set(vaultPath, mutex);
  }
  return mutex;
}

// Custom HTTP client that uses Obsidian's requestUrl (mobile-safe, bypasses CORS)
const gitHttp = {
  async request({ url, method, headers, body }: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: AsyncIterableIterator<Uint8Array>;
  }) {
    let bodyBuffer: ArrayBuffer | undefined;
    if (body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
      bodyBuffer = merged.buffer;
    }

    const response = await requestUrl({
      url,
      method: method ?? "GET",
      headers: headers ?? {},
      body: bodyBuffer,
      throw: false,
    });

    const arrayBuffer = response.arrayBuffer;
    async function* responseBody() {
      yield new Uint8Array(arrayBuffer);
    }

    return {
      url,
      method,
      statusCode: response.status,
      statusMessage: "OK",
      body: responseBody(),
      headers: response.headers as Record<string, string>,
    };
  },
};

/**
 * State captured when a merge stops on real conflicts. The merge is NOT applied
 * until every conflicted path has a resolution, so an abandoned conflict modal
 * leaves the repo exactly as it was.
 */
type PendingMerge = {
  sessionId: string;
  ourHead: string;
  theirHead: string;
  /** Conflicted paths still awaiting a user decision. */
  unresolved: Set<string>;
  /** path → the content the user chose to keep. */
  resolutions: Map<string, ConflictChoice>;
  /**
   * Paths conflicting because one side DELETED the file. isomorphic-git's
   * mergeDriver is never consulted for these, so they need the manual path.
   */
  deletions: Set<string>;
  /** Excluded conflicts resolved automatically from the remote commit tree. */
  excludedResolutions: Set<string>;
  binaryConflicts: Set<string>;
};

export class GitSync {
  private fs: ReturnType<typeof createFsAdapter>;
  private dir: string;
  private token: string;
  private username: string;
  private remoteUrl: string;
  private mutex: SyncMutex;
  private readonly conflictSessionEpoch = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  /** Set when sync() hits real merge conflicts; consumed by resolveConflict(). */
  private pendingMerge: PendingMerge | null = null;
  /** Paths the user excluded from sync; never staged, never treated as conflicts. */
  private isExcluded: (filepath: string) => boolean;

  constructor(
    adapter: DataAdapter,
    vaultPath: string,
    token: string,
    username: string,
    repoName: string,
    isExcluded: (filepath: string) => boolean = () => false
  ) {
    const normalizedVaultPath = normalizeVaultPath(vaultPath);
    this.fs = createFsAdapter(adapter, normalizedVaultPath);
    this.dir = normalizedVaultPath;
    this.token = token;
    this.username = username;
    this.remoteUrl = `https://github.com/${username}/${repoName}.git`;
    this.isExcluded = (filepath) => isExcluded(normalizeGitPath(filepath));
    this.mutex = mutexFor(adapter, normalizedVaultPath);
  }

  /** Base options shared by ALL git operations (local and network) */
  private gitOpts() {
    return {
      fs: this.fs,
      http: gitHttp,
      dir: this.dir,
      author: { name: GIT_AUTHOR_NAME, email: GIT_AUTHOR_EMAIL },
    };
  }

  /**
   * Extra options for NETWORK operations (push / fetch / clone).
   *
   * isomorphic-git strips credentials from remote URLs before sending requests.
   * We must supply them via `onAuth` so every push/fetch is authenticated.
   * We also pass `url` directly so the library does not have to read `.git/config`.
   */
  private netOpts() {
    const token = this.token;
    const username = this.username;
    return {
      ...this.gitOpts(),
      url: this.remoteUrl,
      onAuth: () => ({ username, password: token }),
      onAuthFailure: () => {
        throw new Error("GitHub authentication failed. Please reconnect your account in MultiSync settings.");
      },
    };
  }

  /** Returns true if .git exists and HEAD resolves (repo is initialised) */
  async isInitialized(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  private async hasGitDirectory(): Promise<boolean> {
    try {
      await this.fs.promises.stat(this.repoPath(".git"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns true if refs/heads/main exists (at least one commit has been made).
   * Returns false on a fresh git.init with no commits (unborn branch).
   */
  async hasLocalBranch(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch from origin. Returns the FETCH_HEAD oid when remote has commits,
   * or null when a reachable remote has no main branch. Genuine transport,
   * authentication, permission, and repository errors set lastFetchError.
   */
  private async safeFetch(): Promise<string | null> {
    try {
      // git.fetch returns the fetched head oid directly. isomorphic-git does not
      // reliably write a FETCH_HEAD ref (especially with a custom fs), so use the
      // return value; fall back to the remote-tracking ref it *does* update.
      const res = await git.fetch({
        ...this.netOpts(),
        ref: DEFAULT_BRANCH,
        singleBranch: true,
      });
      if (res.fetchHead) return res.fetchHead;

      // The fetch itself completed successfully. A newly-created GitHub
      // repository has no main branch and therefore no remote-tracking ref yet;
      // that is an empty remote, not a fetch failure. The tracking-ref fallback
      // is only needed for isomorphic-git versions that omit fetchHead despite
      // updating refs/remotes/origin/main.
      try {
        return await git.resolveRef({
          fs: this.fs,
          dir: this.dir,
          ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
        });
      } catch (error) {
        if ((error as { code?: string }).code === "NotFoundError") return null;
        throw error;
      }
    } catch (e) {
      // Surface WHY fetch failed instead of silently swallowing it.
      const code = (e as { code?: string })?.code ?? "?";
      const m = e instanceof Error ? e.message : String(e);
      this.lastFetchError = `fetch failed code=${code} msg=${m}`;
      return null;
    }
  }

  /** Set by safeFetch when a fetch attempt throws; read by sync() for logging. */
  private lastFetchError: string | null = null;

  private repoPath(path: string): string {
    return this.dir ? `${this.dir}/${path}` : path;
  }

  private async recoverInterruptedOperation(): Promise<void> {
    const journalPath = this.repoPath(`${RECOVERY_DIR}/journal.json`);
    let raw: string;
    try {
      raw = String(await this.fs.promises.readFile(journalPath, "utf8"));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw error;
    }

    let journal: RecoveryJournal;
    try {
      journal = JSON.parse(raw) as RecoveryJournal;
    } catch {
      throw new Error(`Sync recovery journal is corrupted at ${RECOVERY_DIR}/journal.json; user files were not changed.`);
    }
    if (
      journal.version !== RECOVERY_SCHEMA_VERSION ||
      journal.operation !== "excluded-working-tree" ||
      journal.phase !== "snapshotted" ||
      !Array.isArray(journal.snapshots)
    ) {
      throw new Error(`Unsupported sync recovery journal at ${RECOVERY_DIR}/journal.json; user files were not changed.`);
    }

    // Validate every entry and load every referenced snapshot before changing a
    // single vault file. Recovery metadata is untrusted even though it lives in
    // .git; adapter path containment is never relied upon.
    const validated: Array<{ path: string; existed: boolean; data?: Buffer }> = [];
    for (const snapshot of journal.snapshots) {
      if (!snapshot || typeof snapshot !== "object" || !isSafeRelativePath(snapshot.path)) {
        throw new Error("Unsafe recovery journal path; user files were not changed.");
      }
      const filepath = snapshot.path;
      if (!this.isExcluded(filepath) || typeof snapshot.existed !== "boolean") {
        throw new Error(`Unsafe recovery journal path '${filepath}'; user files were not changed.`);
      }
      let data: Buffer | undefined;
      if (snapshot.existed) {
        if (!isSafeSnapshotBasename(snapshot.file)) {
          throw new Error(`Unsafe recovery snapshot filename for '${filepath}'; user files were not changed.`);
        }
        data = Buffer.from(await this.fs.promises.readFile(this.repoPath(`${RECOVERY_DIR}/${snapshot.file}`)) as Buffer);
      } else if (snapshot.file !== undefined) {
        throw new Error(`Unexpected recovery snapshot filename for '${filepath}'; user files were not changed.`);
      }
      validated.push({ path: filepath, existed: snapshot.existed, data });
    }

    // Restoration is deliberately the only automatic recovery action. Git refs
    // are left untouched; the next fetch/merge observes actual repository state.
    for (const snapshot of validated) {
      if (snapshot.existed) await this.fs.promises.writeFile(this.repoPath(snapshot.path), snapshot.data!);
      else await this.fs.promises.unlink(this.repoPath(snapshot.path));
    }
    await this.clearRecoveryJournal(journal);
    this.pendingMerge = null;
  }

  private async clearRecoveryJournal(journal: RecoveryJournal): Promise<void> {
    // Remove the authoritative marker first. A crash during subsequent cleanup
    // can leave harmless orphan snapshot blobs, but can never leave a journal
    // that points at a snapshot already deleted by cleanup.
    await this.fs.promises.unlink(this.repoPath(`${RECOVERY_DIR}/journal.json`));
    for (const snapshot of journal.snapshots) {
      if (isSafeSnapshotBasename(snapshot.file)) {
        await this.fs.promises.unlink(this.repoPath(`${RECOVERY_DIR}/${snapshot.file}`));
      }
    }
  }

  /**
   * Clone the remote into the vault directory.
   * Returns true if the clone produced a usable local branch (non-empty remote).
   *
   * We clone with `noCheckout` and then check out ONLY the non-excluded paths.
   * A default `git.clone` checks out the entire remote tree, which overwrites (or
   * fails on) device-local files the running Obsidian instance has already
   * written — most notably `.obsidian/*` config the remote happens to track
   * because another tool committed it. Filtering the checkout keeps the remote's
   * excluded files out of the working tree entirely; they still exist in HEAD, and
   * `trackedStatus()`/`checkoutMergedPaths()` keep ignoring them on every later
   * sync, so they never resurface as spurious deletions.
   */
  async clone(): Promise<boolean> {
    return this.mutex.run(async () => {
      await this.recoverInterruptedOperation();
      return this.cloneUnlocked();
    });
  }

  private async cloneUnlocked(): Promise<boolean> {
    if (await this.hasGitDirectory()) {
      // A terminated no-checkout clone may leave .git present but no local
      // branch. Fetch the actual remote and safely finish local setup instead of
      // deleting either the repository or user working files.
      if (!(await this.hasLocalBranch())) {
        try {
          await git.deleteRemote({ fs: this.fs, dir: this.dir, remote: "origin" });
        } catch { /* partial setup may not have written the remote yet */ }
        await git.addRemote({
          fs: this.fs,
          dir: this.dir,
          remote: "origin",
          url: this.remoteUrl,
        });
        const fetchResult = await git.fetch({
          ...this.netOpts(),
          ref: DEFAULT_BRANCH,
          singleBranch: true,
          depth: 1,
        });
        const fetched = fetchResult.fetchHead ?? null;
        if (!fetched) return false;
        await git.writeRef({
          fs: this.fs,
          dir: this.dir,
          ref: `refs/heads/${DEFAULT_BRANCH}`,
          value: fetched,
          force: false,
        });
      }
    } else {
      await git.clone({
        ...this.netOpts(),
        singleBranch: true,
        depth: 1,
        noCheckout: true,
      });
    }

    if (!(await this.hasLocalBranch())) return false;

    const head = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
    const files = await git.listFiles({ fs: this.fs, dir: this.dir, ref: head });
    const wanted = files.filter((p) => !this.isExcluded(p));
    const collisions: string[] = [];
    for (const filepath of wanted) {
      const local = await this.readWorkingFileIfPresent(filepath);
      if (!local) continue;
      const remote = await this.readBlobBytesAt(head, filepath);
      if (!remote.exists || !Buffer.from(local).equals(Buffer.from(remote.content))) collisions.push(filepath);
    }
    if (collisions.length > 0) {
      throw new Error(`Clone stopped to preserve differing local file(s): ${collisions.join(", ")}`);
    }
    if (wanted.length > 0) {
      await git.checkout({
        fs: this.fs,
        dir: this.dir,
        ref: DEFAULT_BRANCH,
        force: true,
        filepaths: wanted,
      });
    }
    return true;
  }

  private async readWorkingFileIfPresent(filepath: string): Promise<Buffer | null> {
    try {
      return Buffer.from(await this.fs.promises.readFile(this.repoPath(filepath)) as Buffer);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * First-time setup: init locally (if needed), commit everything, push.
   * Safe to call on a partially-initialised repo (retry after failure).
   */
  async initAndPush(vaultFiles: string[]): Promise<void> {
    return this.mutex.run(async () => {
      await this.recoverInterruptedOperation();
      return this.initAndPushUnlocked(vaultFiles);
    });
  }

  private async initAndPushUnlocked(vaultFiles: string[]): Promise<void> {
    const alreadyInited = await this.isInitialized();
    if (!alreadyInited) {
      await git.init({ fs: this.fs, dir: this.dir, defaultBranch: DEFAULT_BRANCH });
    }

    // Stage all vault files (skip any that fail)
    for (const inputFile of vaultFiles) {
      const file = normalizeGitPath(inputFile);
      if (this.isExcluded(file)) continue;
      try {
        await git.add({ fs: this.fs, dir: this.dir, filepath: file });
      } catch {
        // Skip un-stageable files (binary, permission issues, etc.)
      }
    }

    const localBranchExists = await this.hasLocalBranch();
    if (!localBranchExists) {
      // On an unborn repository isomorphic-git's short `ref: "main"` can create
      // an object without establishing refs/heads/main. Create the commit object
      // first, then explicitly establish both the branch and symbolic HEAD.
      const initialOid = await git.commit({
        ...this.gitOpts(),
        ref: DEFAULT_BRANCH,
        noUpdateBranch: true,
        message: "sync: initial vault snapshot",
      });
      await git.writeRef({
        fs: this.fs,
        dir: this.dir,
        ref: `refs/heads/${DEFAULT_BRANCH}`,
        value: initialOid,
        force: false,
      });
      await git.writeRef({
        fs: this.fs,
        dir: this.dir,
        ref: "HEAD",
        value: `refs/heads/${DEFAULT_BRANCH}`,
        force: true,
        symbolic: true,
      });
    } else {
      // Subsequent call (retry) — only commit if something changed
      const status = await git.statusMatrix({ fs: this.fs, dir: this.dir });
      const dirty = status.some(([, h, w, s]) => h !== 1 || w !== 1 || s !== 1);
      if (dirty) {
        await git.commit({
          ...this.gitOpts(),
          ref: DEFAULT_BRANCH,
          message: "sync: initial vault snapshot",
        });
      }
    }

    if (!(await this.hasLocalBranch())) {
      throw new Error(`Initialization failed: could not establish local branch '${DEFAULT_BRANCH}'.`);
    }

    // Set up remote (delete+re-add to ensure correct fetch refspec)
    try {
      await git.deleteRemote({ fs: this.fs, dir: this.dir, remote: "origin" });
    } catch { /* didn't exist yet */ }
    await git.addRemote({
      fs: this.fs,
      dir: this.dir,
      remote: "origin",
      url: this.remoteUrl,
    });

    try {
      const localHead = await git.resolveRef({
        fs: this.fs,
        dir: this.dir,
        ref: DEFAULT_BRANCH,
      });
      const pushResult = await this.pushMain();
      await this.verifyPushResult(pushResult, localHead);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Initialization created local '${DEFAULT_BRANCH}' but could not push it: ${message}`);
    }
  }

  /**
   * Full sync cycle — runs on every file change and manual sync trigger.
   *
   *   1. Stage + commit local work FIRST, so nothing on disk can be clobbered
   *      by the merge/checkout that follows.
   *   2. Fetch, then merge the remote in. A real merge conflict is reported to
   *      the caller WITHOUT mutating the repo (see mergeRemote).
   *   3. Push (skipped when conflicts are outstanding or nothing is ahead).
   *
   * Committing before merging is safe: isomorphic-git creates a proper merge
   * commit for diverged histories, so remote work is never dropped.
   */
  async sync(changedFiles: string[]): Promise<SyncResult> {
    return this.mutex.run(async () => {
      await this.recoverInterruptedOperation();
      return this.syncUnlocked(changedFiles);
    });
  }

  private async syncUnlocked(changedFiles: string[]): Promise<SyncResult> {
    const logs: string[] = [];
    const log = (m: string) => { logs.push(m); console.log(`[git-sync] ${m}`); };
    const short = (oid: string | null) => (oid ? oid.slice(0, 7) : String(oid));

    log(`sync() start — ${changedFiles.length} candidate files`);

    try {
      // ── 1. Commit local work FIRST (protects unsaved edits from checkout) ────
      for (const inputFile of changedFiles) {
        const file = normalizeGitPath(inputFile);
        if (this.isExcluded(file)) continue;
        try {
          await git.add({ fs: this.fs, dir: this.dir, filepath: file });
        } catch {
          try {
            await git.remove({ fs: this.fs, dir: this.dir, filepath: file });
          } catch { /* skip */ }
        }
      }

      // Commit ONLY if the staged tree differs from HEAD. Otherwise we'd create a
      // phantom commit that advances local HEAD past the remote for no reason.
      const hasLocal = await this.hasLocalBranch();
      let stagedChange = false;
      try {
        const matrix = await this.trackedStatus();
        stagedChange = matrix.some(([, head, , stage]) => stage !== head);
      } catch {
        stagedChange = changedFiles.length > 0; // unborn branch / status unavailable
      }
      const mustCommit = stagedChange || !hasLocal;
      log(`step1 stagedChange=${stagedChange} hasLocal=${hasLocal} commit=${mustCommit}`);

      if (mustCommit) {
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        const oid = await git.commit({ ...this.gitOpts(), message: `sync: ${now}` });
        log(`step1 committed=${short(oid)}`);
      }

      // ── 2. Fetch + merge remote ─────────────────────────────────────────────
      this.lastFetchError = null;
      const fetchHead = await this.safeFetch();
      log(`step2 fetchHead=${short(fetchHead)}`);
      if (fetchHead === null && this.lastFetchError) {
        log(`step2 ${this.lastFetchError}`);
        throw new Error(this.lastFetchError);
      }

      const dirtyAfterFetch = (await this.trackedStatus())
        .filter(([, head, workdir]) => workdir !== head)
        .map(([filepath]) => filepath);
      if (dirtyAfterFetch.length > 0) {
        throw new Error(`Local files changed during sync; retrying is required: ${dirtyAfterFetch.join(", ")}`);
      }

      let conflicts = await this.mergeRemote(fetchHead, log);

      // ── 3. Push ─────────────────────────────────────────────────────────────
      if (conflicts.length === 0 && (await this.hasLocalBranch())) {
        conflicts = await this.pushWithRetry(log, short);
      }

      log(`sync() OK conflicts=${conflicts.length}`);
      return { success: conflicts.length === 0, conflictFiles: conflicts, logs };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`sync() FAILED: ${msg}`);
      return { success: false, conflictFiles: [], error: msg, logs };
    }
  }

  /**
   * Push local main, retrying only when GitHub rejects the push because the
   * remote advanced after our last fetch. Each retry fetches the latest remote,
   * merges it through the same conflict-safe merge path, and then attempts a
   * normal non-forced push again.
   */
  private async pushWithRetry(
    log: (m: string) => void,
    short: (oid: string | null) => string
  ): Promise<ConflictFile[]> {
    let attempt = 1;

    while (attempt <= MAX_PUSH_ATTEMPTS) {
      const localHead = await git.resolveRef({
        fs: this.fs,
        dir: this.dir,
        ref: DEFAULT_BRANCH,
      });
      let remoteHead: string | null = null;
      try {
        remoteHead = await git.resolveRef({
          fs: this.fs,
          dir: this.dir,
          ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
        });
      } catch {
        /* no remote ref yet */
      }

      if (localHead === remoteHead) {
        log(`step3 nothing to push (local == remote)`);
        return [];
      }

      try {
        log(`step3 pushing attempt=${attempt} local=${short(localHead)} remote=${short(remoteHead)}`);
        const pushRes = await this.pushMain();
        await this.verifyPushResult(pushRes, localHead);
        log(`step3 push success attempt=${attempt} local=${short(localHead)}`);
        if (remoteHead === null) log(`step3 remote ${DEFAULT_BRANCH} created`);
        return [];
      } catch (e) {
        log(`step3 push rejected attempt=${attempt}: ${e instanceof Error ? e.message : String(e)}`);
        if (!this.isNonFastForwardPushError(e) || attempt >= MAX_PUSH_ATTEMPTS) {
          throw e;
        }

        const msg = e instanceof Error ? e.message : String(e);
        log(`step3 non-fast-forward on attempt=${attempt}: ${msg}`);
        this.lastFetchError = null;
        const latest = await this.safeFetch();
        log(`step3 retry fetchHead=${short(latest)}`);
        if (latest === null) {
          if (this.lastFetchError) log(`step3 ${this.lastFetchError}`);
          throw e;
        }

        const conflicts = await this.mergeRemote(latest, log);
        if (conflicts.length > 0) return conflicts;
        attempt++;
      }
    }

    return [];
  }

  /** Perform the one supported push shape. This is deliberately never forced. */
  private pushMain(): Promise<git.PushResult> {
    return git.push({
      ...this.netOpts(),
      ref: DEFAULT_BRANCH,
      remoteRef: DEFAULT_BRANCH,
      force: false,
    });
  }

  /**
   * A resolved push promise is not, by itself, proof that the requested ref was
   * accepted. Require both the receive-pack status and isomorphic-git's updated
   * remote-tracking ref to confirm that origin/main now names our local HEAD.
   */
  private async verifyPushResult(result: git.PushResult, localHead: string): Promise<void> {
    const remoteRef = `refs/heads/${DEFAULT_BRANCH}`;
    const status = result?.refs?.[remoteRef];
    if (!result?.ok || !status?.ok) {
      const reason = status?.error || result?.error || `no successful update for ${remoteRef}`;
      throw new Error(`Push did not update ${remoteRef}: ${reason}`);
    }

    let trackedHead: string;
    try {
      trackedHead = await git.resolveRef({
        fs: this.fs,
        dir: this.dir,
        ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
      });
    } catch {
      throw new Error(`Push reported success but refs/remotes/origin/${DEFAULT_BRANCH} was not created`);
    }
    if (trackedHead !== localHead) {
      throw new Error(
        `Push reported success but origin/${DEFAULT_BRANCH} is ${trackedHead}, expected ${localHead}`
      );
    }
  }

  /** True only for push rejections that should be solved by fetch/merge/retry. */
  private isNonFastForwardPushError(error: unknown): boolean {
    const code = (error as { code?: string })?.code ?? "";
    const msg = error instanceof Error ? error.message : String(error);
    return (
      code === "PushRejectedError" ||
      /not a simple fast-forward|non-fast-forward|fetch first/i.test(msg)
    );
  }


  /**
   * statusMatrix restricted to paths that actually participate in sync.
   *
   * `statusMatrix` lists every untracked file in the working tree. Excluded paths
   * (e.g. `.obsidian/*`) must never influence commit decisions or be mistaken for
   * conflicts, so they are filtered out here.
   */
  private async trackedStatus(): Promise<Array<[string, number, number, number]>> {
    const matrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
    return matrix.filter(([filepath]) => !this.isExcluded(filepath)) as Array<
      [string, number, number, number]
    >;
  }

  /**
   * Merge the fetched remote head into the local branch.
   *
   * Returns the list of genuinely conflicting files. Crucially, when conflicts
   * exist NOTHING is written: the merge runs with `dryRun` so HEAD, the index and
   * the working tree are untouched until every conflict has a resolution. That
   * makes dismissing the conflict modal a true no-op.
   */
  private async mergeRemote(
    fetchHead: string | null,
    log: (m: string) => void
  ): Promise<ConflictFile[]> {
    this.pendingMerge = null;
    if (!fetchHead || !(await this.hasLocalBranch())) return [];

    const ourHead = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
    if (ourHead === fetchHead) {
      log(`step2 already up to date`);
      return [];
    }

    // Probe first: dryRun means a conflict costs us nothing.
    try {
      const res = await git.merge({
        ...this.gitOpts(),
        ours: DEFAULT_BRANCH,
        theirs: fetchHead,
        message: "sync: merge remote changes",
        fastForwardOnly: false,
        abortOnConflict: true,
        dryRun: true,
      });
      log(`step2 merge probe clean=${JSON.stringify(res)}`);
    } catch (e) {
      const err = e as { code?: string; data?: { filepaths?: string[]; deleteByUs?: string[]; deleteByTheirs?: string[] } };
      if (err.code !== "MergeConflictError") throw e;

      const allPaths = err.data?.filepaths ?? [];
      const paths = allPaths.filter((p) => !this.isExcluded(p));
      const excludedPaths = new Set(allPaths.filter((p) => this.isExcluded(p)));
      log(`step2 conflicts=${paths.length} ${JSON.stringify(paths)}`);
      if (paths.length === 0) {
        // Preserve the remote version in the merge commit while restoring the
        // device-local working copy after the index/commit work is complete.
        await this.withExcludedWorkingTreeProtected(ourHead, fetchHead, async () => {
          await this.applyMergeManually(ourHead, fetchHead, new Map(), excludedPaths);
        });
        log(`step2 auto-resolved ${excludedPaths.size} excluded conflict(s) from remote tree`);
        return [];
      }

      const deletions = new Set(
        [...(err.data?.deleteByUs ?? []), ...(err.data?.deleteByTheirs ?? [])]
      );

      this.pendingMerge = {
        sessionId: `conflict-${this.conflictSessionEpoch}-${nextConflictSession++}`,
        ourHead,
        theirHead: fetchHead,
        unresolved: new Set(paths),
        resolutions: new Map(),
        deletions,
        excludedResolutions: excludedPaths,
        binaryConflicts: new Set(),
      };

      const conflicts: ConflictFile[] = [];
      for (const p of paths) {
        const ours = await this.readBlobBytesAt(ourHead, p);
        const theirs = await this.readBlobBytesAt(fetchHead, p);
        const isBinary = this.isBinaryContent(ours.content) || this.isBinaryContent(theirs.content);
        if (isBinary) this.pendingMerge.binaryConflicts.add(p);
        conflicts.push({
          conflictSessionId: this.pendingMerge.sessionId,
          path: p,
          ours: isBinary ? "" : new TextDecoder().decode(ours.content),
          theirs: isBinary ? "" : new TextDecoder().decode(theirs.content),
          oursExists: ours.exists,
          theirsExists: theirs.exists,
          isBinary,
          oursBytes: isBinary ? Array.from(ours.content) : undefined,
          theirsBytes: isBinary ? Array.from(theirs.content) : undefined,
        });
      }
      return conflicts;
    }

    // No conflicts — apply the merge for real, then materialise it on disk.
    await this.withExcludedWorkingTreeProtected(ourHead, fetchHead, async () => {
      await git.merge({
        ...this.gitOpts(),
        ours: DEFAULT_BRANCH,
        theirs: fetchHead,
        message: "sync: merge remote changes",
        fastForwardOnly: false,
        abortOnConflict: true,
      });
    });
    await this.checkoutMergedPaths(ourHead, log);
    return [];
  }

  /**
   * Check out only the paths the merge actually changed.
   *
   * A blanket `checkout({ force: true })` would overwrite every dirty file in the
   * vault — including excluded files and edits Obsidian hasn't flushed yet.
   */
  private async checkoutMergedPaths(
    beforeHead: string,
    log: (m: string) => void
  ): Promise<void> {
    try {
      const afterHead = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
      if (afterHead === beforeHead) return;

      const [before, after] = await Promise.all([
        git.listFiles({ fs: this.fs, dir: this.dir, ref: beforeHead }),
        git.listFiles({ fs: this.fs, dir: this.dir, ref: afterHead }),
      ]);

      const changed: string[] = [];
      for (const filepath of new Set([...before, ...after])) {
        if (this.isExcluded(filepath)) continue;
        const [a, b] = await Promise.all([
          this.blobOidAt(beforeHead, filepath),
          this.blobOidAt(afterHead, filepath),
        ]);
        if (a !== b) changed.push(filepath);
      }

      if (changed.length === 0) return;
      await git.checkout({
        fs: this.fs,
        dir: this.dir,
        ref: DEFAULT_BRANCH,
        force: true,
        filepaths: changed,
      });
      log(`step2 checked out ${changed.length} merged path(s)`);
    } catch (e) {
      const message = `step2 checkout failed: ${e instanceof Error ? e.message : String(e)}`;
      log(message);
      throw new Error(message);
    }
  }

  /**
   * Record the user's decision for one conflicted file.
   *
   * The merge is only applied once EVERY conflicted path has been decided, and it
   * is applied as a single real merge commit (two parents) whose tree is built by
   * isomorphic-git. That preserves the remote's non-conflicting changes — hand-
   * building the commit from the index would silently drop them.
   *
   * Returns a structured result so stale UI sessions cannot mutate the repo.
   */
  async resolveConflict(
    filepath: string,
    resolvedContent: ConflictChoice | string,
    conflictSessionId: string
  ): Promise<ConflictResolutionResult> {
    const gitPath = normalizeGitPath(filepath);
    return this.mutex.run(async () => {
      await this.recoverInterruptedOperation();
      return this.resolveConflictUnlocked(gitPath, resolvedContent, conflictSessionId);
    });
  }

  private async resolveConflictUnlocked(
    filepath: string,
    resolvedContent: ConflictChoice | string,
    conflictSessionId: string
  ): Promise<ConflictResolutionResult> {
    const pending = this.pendingMerge;
    if (!pending) {
      return {
        completed: false,
        stale: true,
        message: "This conflict is no longer active. Please sync again to refresh conflicts.",
      };
    }

    if (conflictSessionId !== pending.sessionId) {
      return {
        completed: false,
        stale: true,
        message: "This conflict session is stale. Please reopen the latest conflict prompt.",
      };
    }

    if (!(await this.isPendingMergeCurrent(pending))) {
      this.pendingMerge = null;
      return {
        completed: false,
        stale: true,
        message: "Repository state changed while this conflict was open. Please sync again.",
      };
    }

    const choice: ConflictChoice = typeof resolvedContent === "string"
      ? { exists: true, content: resolvedContent }
      : resolvedContent;
    pending.resolutions.set(filepath, choice);
    pending.unresolved.delete(filepath);
    if (pending.unresolved.size > 0) return { completed: false, stale: false };

    // All decisions in — replay the merge, injecting the chosen content.
    const { ourHead, theirHead, resolutions, deletions, excludedResolutions, binaryConflicts } = pending;
    this.pendingMerge = null;

    if (deletions.size === 0 && excludedResolutions.size === 0 && binaryConflicts.size === 0) {
      // Content-only conflicts: let isomorphic-git build the merge tree via the
      // merge driver. This keeps the remote's non-conflicting changes intact.
      await git.merge({
        ...this.gitOpts(),
        ours: DEFAULT_BRANCH,
        theirs: theirHead,
        message: "sync: merge remote changes (conflicts resolved)",
        fastForwardOnly: false,
        abortOnConflict: true,
        mergeDriver: ({ path: p, contents }) => {
          const chosen = resolutions.get(p);
          return chosen !== undefined
            ? { cleanMerge: true, mergedText: String(chosen.content) }
            : { cleanMerge: false, mergedText: contents[1] };
        },
      });
      await this.checkoutMergedPaths(ourHead, () => {});
    } else {
      // A delete/modify conflict never reaches the merge driver, so apply the
      // merge with conflict markers, overwrite each decided path, then commit a
      // real two-parent merge. Staging is restricted to paths tracked by either
      // side so untracked/excluded files are never swept in.
      await this.withExcludedWorkingTreeProtected(ourHead, theirHead, async () => {
        await this.applyMergeManually(ourHead, theirHead, resolutions, excludedResolutions);
      });
    }

    // The remote may have advanced while the conflict modal was open. Reuse the
    // normal bounded fetch/merge/push discipline rather than doing a one-shot
    // push. mergeRemote() creates a fresh pending session if that retry reveals
    // another conflict; the session resolved above has already been cleared.
    const log = (message: string) => console.log(`[git-sync] ${message}`);
    const short = (oid: string | null) => (oid ? oid.slice(0, 7) : String(oid));
    const conflicts = await this.pushWithRetry(log, short);
    if (conflicts.length > 0) {
      return { completed: false, stale: false, conflictFiles: conflicts };
    }
    return { completed: true, stale: false };
  }

  private async isPendingMergeCurrent(pending: PendingMerge): Promise<boolean> {
    try {
      const currentHead = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
      if (currentHead !== pending.ourHead) return false;

      const currentRemote = await git.resolveRef({
        fs: this.fs,
        dir: this.dir,
        ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
      });
      return currentRemote === pending.theirHead;
    } catch {
      return false;
    }
  }

  /**
   * Fallback merge path for delete/modify conflicts.
   *
   * `git.merge({ abortOnConflict: false })` writes the merge into the index and
   * working tree, we then force each conflicted path to the user's choice and
   * commit with both parents so the remote history is properly included.
   */
  private async applyMergeManually(
    ourHead: string,
    theirHead: string,
    resolutions: Map<string, ConflictChoice>,
    excludedResolutions: Set<string> = new Set()
  ): Promise<void> {
    try {
      await git.merge({
        ...this.gitOpts(),
        ours: DEFAULT_BRANCH,
        theirs: theirHead,
        message: "sync: merge remote changes (conflicts resolved)",
        fastForwardOnly: false,
        abortOnConflict: false,
      });
    } catch (e) {
      if ((e as { code?: string }).code !== "MergeConflictError") throw e;
    }

    // Apply the user's decision for every conflicted path.
    for (const [filepath, choice] of resolutions) {
      if (!choice.exists) {
        await this.fs.promises.unlink(`${this.dir}/${filepath}`);
      } else {
        await this.fs.promises.writeFile(`${this.dir}/${filepath}`, choice.content);
      }
    }

    // Excluded conflicts never require a user decision. Put the remote side in
    // the index/merge tree, then restore the device-local working copy after the
    // merge commit via withExcludedWorkingTreeProtected().
    for (const filepath of excludedResolutions) {
      if (await this.blobOidAt(theirHead, filepath)) {
        await git.checkout({
          fs: this.fs,
          dir: this.dir,
          ref: theirHead,
          filepaths: [filepath],
          force: true,
        });
        await git.add({ fs: this.fs, dir: this.dir, filepath });
      } else {
        await git.remove({ fs: this.fs, dir: this.dir, filepath });
      }
    }

    // Stage only paths tracked by one of the two sides.
    const tracked = new Set([
      ...(await git.listFiles({ fs: this.fs, dir: this.dir, ref: ourHead })),
      ...(await git.listFiles({ fs: this.fs, dir: this.dir, ref: theirHead })),
    ]);
    for (const [filepath, head, workdir, stage] of await this.trackedStatus()) {
      if (!tracked.has(filepath)) continue;
      if (workdir === 0) {
        await git.remove({ fs: this.fs, dir: this.dir, filepath });
      } else if (stage !== head || workdir !== head || stage === 3) {
        await git.add({ fs: this.fs, dir: this.dir, filepath });
      }
    }
    const unresolved = (await git.statusMatrix({ fs: this.fs, dir: this.dir }))
      .filter(([filepath, , , stage]) => tracked.has(filepath) && !this.isExcluded(filepath) && stage === 3)
      .map(([filepath]) => filepath);
    if (unresolved.length > 0) {
      throw new Error(`Cannot create merge commit with unresolved paths: ${unresolved.join(", ")}`);
    }

    await git.commit({
      ...this.gitOpts(),
      ref: DEFAULT_BRANCH,
      message: "sync: merge remote changes (conflicts resolved)",
      parent: [ourHead, theirHead],
    });
    await this.checkoutMergedPaths(ourHead, () => {});
  }

  /** Keep excluded working files byte-for-byte local while Git advances its tree. */
  private async withExcludedWorkingTreeProtected<T>(
    ourHead: string,
    theirHead: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const tracked = new Set([
      ...(await git.listFiles({ fs: this.fs, dir: this.dir, ref: ourHead })),
      ...(await git.listFiles({ fs: this.fs, dir: this.dir, ref: theirHead })),
    ]);
    const excludedTracked = [...tracked].filter((filepath) => this.isExcluded(filepath));
    if (excludedTracked.length === 0) return operation();
    const operationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const journal: RecoveryJournal = {
      version: RECOVERY_SCHEMA_VERSION,
      operationId,
      operation: "excluded-working-tree",
      phase: "snapshotted",
      localHead: ourHead,
      remoteHead: theirHead,
      timestamp: new Date().toISOString(),
      snapshots: [],
    };
    await this.fs.promises.mkdir(this.repoPath(RECOVERY_DIR), { recursive: true });
    for (const filepath of excludedTracked) {
      try {
        const data = await this.fs.promises.readFile(this.repoPath(filepath));
        const file = `${operationId}-${journal.snapshots.length}.bin`;
        await this.fs.promises.writeFile(this.repoPath(`${RECOVERY_DIR}/${file}`), data as Buffer);
        journal.snapshots.push({ path: filepath, existed: true, file });
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
        journal.snapshots.push({ path: filepath, existed: false });
      }
    }

    // Snapshots reach durable device-local storage before the journal makes the
    // operation recoverable and before Git may touch an excluded path.
    await this.fs.promises.writeFile(
      this.repoPath(`${RECOVERY_DIR}/journal.json`),
      JSON.stringify(journal)
    );

    try {
      return await operation();
    } finally {
      for (const snapshot of journal.snapshots) {
        if (!snapshot.existed) await this.fs.promises.unlink(this.repoPath(snapshot.path));
        else {
          const data = await this.fs.promises.readFile(
            this.repoPath(`${RECOVERY_DIR}/${snapshot.file!}`)
          );
          await this.fs.promises.writeFile(this.repoPath(snapshot.path), data as Buffer);
        }
      }
      await this.clearRecoveryJournal(journal);
    }
  }

  /** Discard an in-flight merge (user dismissed the conflict modal). */
  async abandonMerge(conflictSessionId: string): Promise<void> {
    await this.mutex.run(async () => {
      await this.recoverInterruptedOperation();
      if (this.pendingMerge?.sessionId === conflictSessionId) {
        this.pendingMerge = null;
      }
    });
  }

  /**
   * Pull-only — used on vault open to get latest without pushing.
   *
   * Returns any conflicts so the caller can surface the modal. Like sync(), a
   * conflicting merge leaves the repo untouched until the user decides.
   */
  async pull(): Promise<ConflictFile[]> {
    return this.mutex.run(async () => {
      await this.recoverInterruptedOperation();
      return this.pullUnlocked();
    });
  }

  private async pullUnlocked(): Promise<ConflictFile[]> {
    if (!(await this.hasLocalBranch())) return [];

    this.lastFetchError = null;
    const fetchHead = await this.safeFetch();
    if (!fetchHead) {
      if (this.lastFetchError) throw new Error(this.lastFetchError);
      return [];
    }

    return this.mergeRemote(fetchHead, (m) => console.log(`[git-sync] ${m}`));
  }

  private async readBlobBytesAt(
    oid: string,
    filepath: string
  ): Promise<{ exists: boolean; content: Uint8Array }> {
    try {
      const { blob } = await git.readBlob({ fs: this.fs, dir: this.dir, oid, filepath });
      return { exists: true, content: blob };
    } catch {
      return { exists: false, content: new Uint8Array() };
    }
  }

  private isBinaryContent(content: Uint8Array): boolean {
    if (content.includes(0)) return true;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(content);
      return false;
    } catch {
      return true;
    }
  }

  /** Blob oid of `filepath` at commit `oid`, or null when the path is absent. */
  private async blobOidAt(oid: string, filepath: string): Promise<string | null> {
    try {
      const { oid: blobOid } = await git.readBlob({
        fs: this.fs,
        dir: this.dir,
        oid,
        filepath,
      });
      return blobOid;
    } catch {
      return null;
    }
  }
}
