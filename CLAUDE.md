# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Obsidian community plugin ("Git Sync Vault") that syncs a vault across devices by committing it to the user's own private GitHub repo. Runs on desktop **and** mobile (iOS/Android), so all git and HTTP work goes through pure-JS/Obsidian APIs — no native binaries, no Node `fs`, no `fetch`.

## Commands

```bash
npm install
npm run dev      # esbuild watch mode — rebuilds main.js on save (inline sourcemaps)
npm run build    # production build — minified, no sourcemaps
```

There is **no test suite or linter**, and no typecheck npm script — but `npx tsc --noEmit` runs clean and is the fastest check after editing (esbuild does not typecheck). `tsconfig.json` is otherwise used by esbuild for transpile only (`isolatedModules`, `strictNullChecks`). Beyond that, verify by loading the built `main.js` in an Obsidian vault.

The build entry is `src/main.ts` → bundled to `main.js` (git-ignored). To test in Obsidian, copy/symlink `main.js` + `manifest.json` into `<vault>/.obsidian/plugins/gitsyncvault/`.

Releases are tag-triggered: pushing a git tag runs `.github/workflows/release.yml`, which builds and attaches `main.js` + `manifest.json` to a GitHub Release.

## Hard mobile constraints (do not break these)

- **All HTTP must use Obsidian's `requestUrl`** (from the `obsidian` module), never `fetch`/`axios`. This is what makes mobile + CORS work. See `src/github/api.ts`, `src/auth/github-device.ts`, and the custom `gitHttp` client in `src/sync/git-sync.ts`.
- **All filesystem access must go through the Obsidian `DataAdapter`**, never Node `fs`. `src/sync/fs-adapter.ts` wraps the adapter into the `fs.promises`-shaped object isomorphic-git expects, and is the *only* place that bridges the two worlds.
- `esbuild.config.mjs` marks `obsidian`, `electron`, all `@codemirror/*`/`@lezer/*`, and Node builtins as `external` — don't import anything that pulls a Node builtin into the runtime path. **Exception: `buffer` is bundled, not external** — mobile has no Node runtime, so the npm polyfill is bundled and `Buffer` injected as a global via `buffer-shim.mjs` (isomorphic-git's deps `readable-stream`/`sha.js`/`pako`/`crc-32` need it). Removing that exception breaks plugin load on mobile.

## Architecture

Layered, with `main.ts` (the `Plugin` subclass) as the only orchestrator. Lower layers never import `main.ts` or touch Obsidian settings.

- **`src/main.ts`** — plugin lifecycle. Registers vault `modify`/`create`/`delete`/`rename` events → `SyncQueue`; pulls on `onLayoutReady`; flushes the queue on `onunload`; owns the connect/disconnect flow and conflict-modal wiring. `isExcluded()` compiles the user's glob-ish `excludePatterns` (only `*` is special) to regex.
- **`src/sync/git-sync.ts`** — `GitSync`, the isomorphic-git wrapper. Owns the full sync cycle: stage → commit-if-dirty → fetch → merge → detect conflicts → push. Every step is individually try/guarded so one failure (e.g. offline fetch) doesn't cascade. `gitOpts()` vs `netOpts()` split matters: network ops need `onAuth` (isomorphic-git strips creds from the URL) and an explicit `url`.
- **`src/sync/queue.ts`** — `SyncQueue`. Debounces file events (`SYNC_DEBOUNCE_MS`, 3s), coalesces into a `Set`, runs one sync at a time (`running` guard), and re-flushes if changes arrived mid-sync.
- **`src/sync/fs-adapter.ts`** — the Obsidian-adapter → isomorphic-git `fs` bridge. isomorphic-git passes **absolute** paths; `rel()` strips the vault base path before calling the adapter (which wants relative paths). On mobile `basePath` is undefined, so paths stay relative.
- **`src/sync/conflict.ts`** — pure line-diff helper for the conflict modal.
- **`src/auth/github-device.ts`** — GitHub OAuth **Device Flow** (no backend server): request a device code, poll the token endpoint honoring `authorization_pending`/`slow_down`.
- **`src/github/api.ts`** — REST calls: get user, check/create the private repo, derive repo name (`obsidian-<slugified-vault-name>`).
- **`src/ui/`** — `settings-tab.ts` (connect flow + options), `status-bar.ts` (clickable status → manual sync), `conflict-modal.ts` (side-by-side keep-mine/keep-theirs).

### Sync-state model to keep in mind

Three distinct states, checked in `initializeRepo` and throughout `GitSync`:
1. `isInitialized()` — local `.git` with a resolvable `HEAD`.
2. `hasLocalBranch()` — `refs/heads/main` exists (≥1 commit; distinguishes an unborn branch after `git.init`).
3. remote existence (`repoExists`) and remote emptiness (`clone()` returns `false` when the remote has no commits).

The initial-push/clone/reconnect branching in `initializeRepo` and the retry-safety in `initAndPush` exist to handle interrupted first pushes (repo created but never pushed). Preserve these guards when editing.

`DEFAULT_BRANCH` is `"main"` and the code assumes a single branch everywhere (`singleBranch: true`). There is no rebase — merges are real merge commits via `git.merge`.

### Conflict-merge invariant (preserve this)

A conflicting merge is **not applied until every conflicted path has a resolution**. `sync()` stashes a `PendingMerge {ourHead, theirHead, unresolved, resolutions, deletions}`; `resolveConflict()` fills it in; only when `unresolved` empties does `applyMergeManually()` commit with both parents. Dismissing the modal calls `abandonMerge()`, leaving the repo byte-identical — the next sync re-offers it. Delete/modify conflicts go in `deletions` because isomorphic-git's `mergeDriver` is never consulted for them.

### Debugging on mobile

Mobile has no reachable dev console, so `GitSync.sync()` accumulates a step trace into `SyncResult.logs` and `main.ts` renders it via `showLogModal()` (scrollable + Copy button). Add `log()` calls there rather than `console.log` when diagnosing a mobile-only issue. `GitSync` takes `isExcluded` as a constructor arg — it never reads plugin settings itself.

## Gotchas

- **The OAuth Client ID is a runtime setting, not a build-time secret.** Each user registers their own GitHub OAuth App (Device Flow enabled) and pastes the Client ID into plugin settings (`settings.clientId`, threaded through `settings-tab.ts` → `requestDeviceCode`). `src/constants.ts` deliberately has no `CLIENT_ID`; the build needs no `.env` or CI secret. Don't reintroduce a build-time inject — see README § "Register a GitHub OAuth App".
- **Plugin identity must stay consistent.** The manifest and runtime plugin ID are `gitsyncvault`, the user-facing name is "Git Sync Vault", and the installation folder must be `.obsidian/plugins/gitsyncvault/`.
- `excludePatterns` matching supports only `*` as a wildcard (converted to `.*`), anchored full-match — not full glob. The default is exactly one entry, `.obsidian/*`: the whole config dir is unsynced because plugin code, themes, and device-local state differ per device. Only notes & attachments sync.
- `vaultNameToRepoName()` just slugifies (no `obsidian-` prefix) and is only a **fallback** — `main.ts:122` prefers the user-supplied `settings.repoName`.
