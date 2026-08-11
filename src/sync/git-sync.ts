import * as git from "isomorphic-git";
import { requestUrl, DataAdapter } from "obsidian";
import { createFsAdapter } from "./fs-adapter";
import {
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  DEFAULT_BRANCH,
} from "../constants";
import { ConflictFile, SyncResult } from "../types";

// Custom HTTP client that uses Obsidian's requestUrl (mobile-safe, bypasses CORS)
const gitHttp = {
  async request({ url, method, headers, body }: {
    url: string;
    method: string;
    headers: Record<string, string>;
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
      method,
      headers,
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
  ourHead: string;
  theirHead: string;
  /** Conflicted paths still awaiting a user decision. */
  unresolved: Set<string>;
  /** path → the content the user chose to keep. */
  resolutions: Map<string, string>;
  /**
   * Paths conflicting because one side DELETED the file. isomorphic-git's
   * mergeDriver is never consulted for these, so they need the manual path.
   */
  deletions: Set<string>;
};

export class GitSync {
  private fs: ReturnType<typeof createFsAdapter>;
  private dir: string;
  private token: string;
  private username: string;
  private remoteUrl: string;
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
    this.fs = createFsAdapter(adapter, vaultPath);
    this.dir = vaultPath;
    this.token = token;
    this.username = username;
    this.remoteUrl = `https://github.com/${username}/${repoName}.git`;
    this.isExcluded = isExcluded;
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
   * or null when the remote is empty or unreachable.
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

      // Fallback: read refs/remotes/origin/main (updated by fetch).
      return await git.resolveRef({
        fs: this.fs,
        dir: this.dir,
        ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
      });
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
    await git.clone({
      ...this.netOpts(),
      singleBranch: true,
      depth: 1,
      noCheckout: true,
    });

    if (!(await this.hasLocalBranch())) return false;

    const head = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
    const files = await git.listFiles({ fs: this.fs, dir: this.dir, ref: head });
    const wanted = files.filter((p) => !this.isExcluded(p));
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

  /**
   * First-time setup: init locally (if needed), commit everything, push.
   * Safe to call on a partially-initialised repo (retry after failure).
   */
  async initAndPush(vaultFiles: string[]): Promise<void> {
    const alreadyInited = await this.isInitialized();
    if (!alreadyInited) {
      await git.init({ fs: this.fs, dir: this.dir, defaultBranch: DEFAULT_BRANCH });
    }

    // Stage all vault files (skip any that fail)
    for (const file of vaultFiles) {
      try {
        await git.add({ fs: this.fs, dir: this.dir, filepath: file });
      } catch {
        // Skip un-stageable files (binary, permission issues, etc.)
      }
    }

    const localBranchExists = await this.hasLocalBranch();
    if (!localBranchExists) {
      // First-ever commit — create it unconditionally so refs/heads/main is written
      // even when the vault is empty.
      await git.commit({
        ...this.gitOpts(),
        message: "sync: initial vault snapshot",
      });
    } else {
      // Subsequent call (retry) — only commit if something changed
      const status = await git.statusMatrix({ fs: this.fs, dir: this.dir });
      const dirty = status.some(([, h, w, s]) => h !== 1 || w !== 1 || s !== 1);
      if (dirty) {
        await git.commit({
          ...this.gitOpts(),
          message: "sync: initial vault snapshot",
        });
      }
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

    await git.push({
      ...this.netOpts(),
      ref: DEFAULT_BRANCH,
      force: false,
    });
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
    const logs: string[] = [];
    const log = (m: string) => { logs.push(m); console.log(`[git-sync] ${m}`); };
    const short = (oid: string | null) => (oid ? oid.slice(0, 7) : String(oid));

    log(`sync() start — ${changedFiles.length} candidate files`);

    try {
      // ── 1. Commit local work FIRST (protects unsaved edits from checkout) ────
      for (const file of changedFiles) {
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
      if (fetchHead === null && this.lastFetchError) log(`step2 ${this.lastFetchError}`);

      const conflicts = await this.mergeRemote(fetchHead, log);

      // ── 3. Push ─────────────────────────────────────────────────────────────
      if (conflicts.length === 0 && (await this.hasLocalBranch())) {
        // Only push if local is actually ahead of the remote-tracking ref.
        const localHead = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
        let remoteHead: string | null = null;
        try { remoteHead = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: `refs/remotes/origin/${DEFAULT_BRANCH}` }); } catch { /* no remote ref yet */ }
        if (localHead !== remoteHead) {
          log(`step3 pushing local=${short(localHead)} remote=${short(remoteHead)}`);
          const pushRes = await git.push({ ...this.netOpts(), ref: DEFAULT_BRANCH });
          log(`step3 pushRes=${JSON.stringify(pushRes?.ok ?? pushRes)}`);
        } else {
          log(`step3 nothing to push (local == remote)`);
        }
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

      const paths = (err.data?.filepaths ?? []).filter((p) => !this.isExcluded(p));
      log(`step2 conflicts=${paths.length} ${JSON.stringify(paths)}`);
      if (paths.length === 0) {
        // Every conflict was in an excluded path — nothing the user should see.
        // We cannot merge automatically, so leave the repo as-is and report clean.
        log(`step2 all conflicts excluded; skipping merge`);
        return [];
      }

      const deletions = new Set(
        [...(err.data?.deleteByUs ?? []), ...(err.data?.deleteByTheirs ?? [])].filter(
          (p) => !this.isExcluded(p)
        )
      );

      this.pendingMerge = {
        ourHead,
        theirHead: fetchHead,
        unresolved: new Set(paths),
        resolutions: new Map(),
        deletions,
      };

      const conflicts: ConflictFile[] = [];
      for (const p of paths) {
        conflicts.push({
          path: p,
          ours: await this.readBlobAt(ourHead, p),
          theirs: await this.readBlobAt(fetchHead, p),
        });
      }
      return conflicts;
    }

    // No conflicts — apply the merge for real, then materialise it on disk.
    await git.merge({
      ...this.gitOpts(),
      ours: DEFAULT_BRANCH,
      theirs: fetchHead,
      message: "sync: merge remote changes",
      fastForwardOnly: false,
      abortOnConflict: true,
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
      log(`step2 checkout skipped: ${e instanceof Error ? e.message : String(e)}`);
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
   * Returns true when the merge was completed and pushed.
   */
  async resolveConflict(filepath: string, resolvedContent: string): Promise<boolean> {
    const pending = this.pendingMerge;
    if (!pending) {
      // No merge in flight — just save the file and let the next sync handle it.
      await this.fs.promises.writeFile(`${this.dir}/${filepath}`, resolvedContent);
      return false;
    }

    pending.resolutions.set(filepath, resolvedContent);
    pending.unresolved.delete(filepath);
    if (pending.unresolved.size > 0) return false;

    // All decisions in — replay the merge, injecting the chosen content.
    const { ourHead, theirHead, resolutions, deletions } = pending;
    this.pendingMerge = null;

    if (deletions.size === 0) {
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
            ? { cleanMerge: true, mergedText: chosen }
            : { cleanMerge: false, mergedText: contents[1] };
        },
      });
      await this.checkoutMergedPaths(ourHead, () => {});
    } else {
      // A delete/modify conflict never reaches the merge driver, so apply the
      // merge with conflict markers, overwrite each decided path, then commit a
      // real two-parent merge. Staging is restricted to paths tracked by either
      // side so untracked/excluded files are never swept in.
      await this.applyMergeManually(ourHead, theirHead, resolutions);
    }

    await git.push({ ...this.netOpts(), ref: DEFAULT_BRANCH });
    return true;
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
    resolutions: Map<string, string>
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
    for (const [filepath, content] of resolutions) {
      // An empty choice means the file did not exist on the chosen side —
      // honour that as a deletion rather than writing a zero-byte file.
      if (content === "") {
        await this.fs.promises.unlink(`${this.dir}/${filepath}`);
      } else {
        await this.fs.promises.writeFile(`${this.dir}/${filepath}`, content);
      }
    }

    // Stage only paths tracked by one of the two sides.
    const tracked = new Set([
      ...(await git.listFiles({ fs: this.fs, dir: this.dir, ref: ourHead })),
      ...(await git.listFiles({ fs: this.fs, dir: this.dir, ref: theirHead })),
    ]);
    for (const [filepath, head, workdir, stage] of await this.trackedStatus()) {
      if (!tracked.has(filepath)) continue;
      try {
        if (workdir === 0) {
          await git.remove({ fs: this.fs, dir: this.dir, filepath });
        } else if (stage !== head || workdir !== head || stage === 3) {
          await git.add({ fs: this.fs, dir: this.dir, filepath });
        }
      } catch { /* leave undecidable paths to the next sync */ }
    }

    await git.commit({
      ...this.gitOpts(),
      message: "sync: merge remote changes (conflicts resolved)",
      parent: [ourHead, theirHead],
    });
    await this.checkoutMergedPaths(ourHead, () => {});
  }

  /** Discard an in-flight merge (user dismissed the conflict modal). */
  abandonMerge(): void {
    this.pendingMerge = null;
  }

  /**
   * Pull-only — used on vault open to get latest without pushing.
   *
   * Returns any conflicts so the caller can surface the modal. Like sync(), a
   * conflicting merge leaves the repo untouched until the user decides.
   */
  async pull(): Promise<ConflictFile[]> {
    if (!(await this.hasLocalBranch())) return [];

    const fetchHead = await this.safeFetch();
    if (!fetchHead) return [];

    return this.mergeRemote(fetchHead, (m) => console.log(`[git-sync] ${m}`));
  }

  /** Contents of `filepath` as of commit `oid`, or "" when absent (deleted there). */
  private async readBlobAt(oid: string, filepath: string): Promise<string> {
    try {
      const { blob } = await git.readBlob({ fs: this.fs, dir: this.dir, oid, filepath });
      return new TextDecoder().decode(blob);
    } catch {
      return "";
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
