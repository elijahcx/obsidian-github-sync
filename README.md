# Git Sync Vault

Git Sync Vault syncs an Obsidian vault between devices using a private GitHub
repository you control. It automatically syncs local changes, checks for remote
changes about every 15 seconds while Auto-sync is enabled, and pauses for your
choice when the same file conflicts. No dedicated sync server or subscription is
required.

Git Sync Vault is based on the original [Git Sync project](https://github.com/livan116/github-valut-sync)
by Livan Kumar. This substantially modified fork is maintained by
[Elijah (`elijahcx`)](https://github.com/elijahcx).

## Features

- Sync notes and attachments through your own private GitHub repository.
- Auto-sync local changes after a configurable debounce (three seconds by default).
- Check for remote changes about every 15 seconds while Auto-sync is enabled.
- Retry later after temporary network failures or offline editing.
- Pause and present choices for same-file conflicts.
- Show current status and shareable, privacy-conscious diagnostics.
- Use a cross-platform design without a native Git executable.

## Platform status

Designed for Windows, macOS, Linux, iOS, and Android.

Validated with disposable-vault testing on:

- Windows
- macOS
- Linux

Mobile validation is ongoing.

## Installation

### Community Plugin directory

Once Git Sync Vault is available in the Obsidian Community Plugin directory:

1. Open **Settings → Community plugins → Browse**.
2. Search for **Git Sync Vault**.
3. Select **Install**, then **Enable**.

Until then, use BRAT or a manual installation for testing.

### BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. In BRAT, choose **Add Beta Plugin**.
3. Enter `https://github.com/elijahcx/obsidian-github-sync`.

### Manual installation

Download the matching release assets and copy them into
`YourVault/.obsidian/plugins/gitsyncvault/`:

- `main.js`
- `manifest.json`
- `styles.css`

Restart Obsidian, then enable **Git Sync Vault** under **Settings → Community
plugins**.

## Setup

Git Sync Vault connects directly to GitHub through your own GitHub account. There
is no shared OAuth application or intermediary sync service.

### 1. Create a GitHub OAuth App

1. Open [GitHub Developer Settings](https://github.com/settings/developers), then
   select **OAuth Apps → New OAuth App**.
2. Choose an application name and provide valid homepage and callback URLs. Device
   Flow does not use the callback URL, so `https://obsidian.md` can be used for
   both URL fields.
3. Register the application and enable **Device Flow** in its settings.
4. Copy the **Client ID**.

Only the Client ID is required. Do not create or enter a Client Secret. The same
Client ID can be reused on each of your devices.

### 2. Connect GitHub

1. Open **Settings → Git Sync Vault**.
2. Enter the OAuth **Client ID**.
3. Enter the repository name you want to use, or leave it blank to derive one from
   the vault name.
4. Select **Connect GitHub**, then approve the Device Flow request in your browser.

Git Sync Vault requests GitHub's `repo` scope so it can create and synchronize a
private repository. The resulting access token is stored in this plugin's local
Obsidian data and is used only for direct communication with GitHub.

### 3. Choose the repository

Use the same GitHub account and repository name for the same vault on every
device. If the repository does not exist, the first device creates it as private.
A later device using the same name connects to the existing repository. Use a
different repository name for each separate vault.

## How sync works

- Local changes sync after the configured debounce, which defaults to three
  seconds.
- Remote changes are checked approximately every 15 seconds while Auto-sync is
  enabled.
- Opening the vault triggers startup reconciliation after Obsidian's workspace is
  ready.
- Temporary network failures leave work pending for a later retry.
- Same-file conflicts pause synchronization until you resolve them.

For an immediate full reconciliation, select the status bar item or run
**Git Sync Vault: Sync vault now** from the Command Palette.

## Conflicts

When two devices independently edit the same content, Git Sync Vault pauses
synchronization and presents a conflict dialog:

- **Keep Mine** uses the version on the current device.
- **Keep Theirs** uses the version received from the remote repository.
- **Open in Editor** closes the dialog and opens the file so you can resolve it
  manually.

Review both versions before choosing. Synchronization remains paused while the
conflict is unresolved.

## Recommended exclusions

The default exclusion is:

```text
.obsidian/*
```

This keeps device-specific Obsidian settings, workspace layout, plugin data, and
installed plugin files local to each device. Keeping this exclusion is recommended
for cross-device use. You may remove it if you intentionally want to synchronize
Obsidian configuration and accept the additional conflict risk.

Add other paths or `*` patterns under **Settings → Git Sync Vault → Excluded
patterns**, one per line. Configure exclusions before the first sync when
possible; adding an exclusion does not erase an already committed path from Git
history.

## Diagnostics

Run **Git Sync Vault: Show sync diagnostics** from the Command Palette to inspect
connection state, queue activity, remote polling, and recent outcomes. The dialog
includes **Copy diagnostics** for sharing a report when requesting support.

Diagnostics intentionally exclude OAuth tokens, note contents, filenames, and
full vault paths.

For bugs and support, open an issue in the
[Git Sync Vault repository](https://github.com/elijahcx/obsidian-github-sync/issues).

## Development

```bash
git clone https://github.com/elijahcx/obsidian-github-sync.git
cd obsidian-github-sync
npm install
npm test
npm run typecheck
npm run build
```

The production build writes `main.js` in the repository root. See
[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for release and Community Plugin
submission procedures.

## Migrating older test installations

Disable any `git-obsi-sync` or `vaultgit-sync` test copy before installing this
plugin under `.obsidian/plugins/gitsyncvault/`. Do not enable multiple identities
at the same time. Settings from an older test identity are not migrated
automatically.

## License & attribution

Licensed under the [MIT License](LICENSE).

Git Sync Vault is based on the original **[Git Sync](https://github.com/livan116/github-valut-sync)**
project by Livan Kumar. This substantially modified fork is maintained by
[Elijah](https://github.com/elijahcx).

The [LICENSE](LICENSE) file remains authoritative for copyright notices and
license terms.
