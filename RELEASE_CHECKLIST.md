# Git Sync Vault 1.0.16 release checklist

This document prepares the first Obsidian Community Plugin submission. It does not
publish a release, create a tag, or submit the plugin automatically.

## Reviewer prerequisite

Before submission, document how this substantially modified fork satisfies
Obsidian's current fork policy: either link publicly verifiable approval from the
original author, or retain evidence that the original author was unreachable and
the policy's inactivity, contact, and response periods were completed. The
existing Livan Kumar attribution must remain in either case.

## GitHub Release

1. Merge this release-preparation branch into `main` after review.
2. Run the full verification commands documented below on the release commit.
3. Create the tag **`1.0.16`** (do not use `v1.0.16`).
4. Create a GitHub Release titled **Git Sync Vault 1.0.16**.
5. Upload exactly:
   - `main.js`
   - `manifest.json`
   - `styles.css`

`styles.css` contains the narrowly scoped Git Sync Vault UI styles and is a
required asset for this release.

### Suggested release notes

> Git Sync Vault 1.0.16 prepares the plugin for its first Obsidian Community
> Plugin submission. This release reflects cross-device desktop validation on
> Windows, macOS, and Linux; approximately 15-second passive remote polling while
> Auto-sync is enabled; improved diagnostics and status visibility; improved
> conflict resolution with automatic conflict modal presentation; and additional
> reliability and recovery hardening. The plugin is designed for iOS and Android,
> but mobile real-device validation is still ongoing.

## Pre-release verification

```bash
npm test
npm run typecheck
npm run build
cmp -s main.js manual-test-build/main.js
cmp -s manifest.json manual-test-build/manifest.json
cmp -s styles.css manual-test-build/styles.css
git diff --check
```

Stage `main.js`, `manifest.json`, and `styles.css` in a temporary
`.release/1.0.16/` directory and verify that all files match their root copies
byte-for-byte. Do not commit `.release`.

`versions.json` intentionally has no `1.0.16` entry because this release retains
the existing `minAppVersion` of `1.0.1`; add a mapping only when that requirement
changes. Historical mappings remain preserved.

## Community Plugin submission (after publishing the release)

1. Sign in at [community.obsidian.md](https://community.obsidian.md).
2. Link the GitHub account that owns the repository, if needed.
3. Open **Plugins → New plugin**.
4. Submit `https://github.com/elijahcx/obsidian-github-sync`.
5. Review and accept the current Developer Policies.
6. Confirm ongoing maintenance and support.
7. Submit the plugin for review.

Do not perform this submission until the `1.0.16` GitHub Release is published and
the release-ready manifest is present on the default branch.
