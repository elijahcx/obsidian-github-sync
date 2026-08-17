# Selective Obsidian settings audit

This audit targets current Obsidian desktop vault configuration on Windows,
macOS, and Linux. The repository had no Obsidian configuration fixture before
this work, so the implementation is intentionally limited to the stable files
and keys below; it does not infer or expose arbitrary JSON files. Production
path construction uses Obsidian's `Vault.configDir` rather than assuming the
default `.obsidian` name.

## Files and classifications

| File below `Vault.configDir` | Observed contents relevant to this feature | Classification | Decision |
| --- | --- | --- | --- |
| `app.json` | `attachmentFolderPath` represents both the default attachment location and an explicit folder such as `Attachments`; `newLinkFormat`; `alwaysUpdateLinks`; and `useMarkdownLinks` (false means wikilinks). It also contains other Files & Links preferences, including new-note location and deletion/link behavior depending on the Obsidian version. | **Safe to sync**, with a whole-file tradeoff | Offer as **Files & links**, off by default. Obsidian does not split the five requested values into a smaller public file, so unrelated preferences in `app.json` travel too. |
| `hotkeys.json` | Per-command shortcut arrays and modifier names. | **Likely safe**, cross-platform caution | Offer separately, off by default, with a warning. `Mod` is portable (Command on macOS, Ctrl elsewhere), but explicit `Ctrl`, `Meta`, or `Alt`/Option bindings and commands supplied by unavailable plugins need not be portable. |
| `appearance.json` | Base/color theme preference, selected community theme, fonts, accent/font-size and enabled CSS snippet names (the exact optional keys vary by version). | **Likely safe** | Offer separately, off by default. This does not copy anything in `themes/` or `snippets/`; a missing theme/snippet can therefore fall back or have no effect. Fonts and native/translucency preferences can also differ by OS. |
| `core-plugins.json` | Core-plugin enablement map. | **Likely safe**, but outside the requested first version | Do not offer yet. Enabling a feature without its companion configuration is surprising. |
| Core-plugin JSON such as `daily-notes.json`, `templates.json`, and version-dependent files | Settings owned by individual core plugins. There is no single universal core-plugin-settings file. | **Likely safe only after per-plugin review** | Do not sync in this version. Paths, formats, and availability require category-by-category design. |
| `workspace.json`, `workspace-mobile.json` | Open panes, tabs, layout and recent workspace state. | **Device-specific** | Do not sync. |
| `plugins/*/data.json` and other third-party plugin files | Arbitrary plugin settings; Git Sync Vault's own `plugins/gitsyncvault/data.json` contains the locally stored OAuth access token and authentication state. | **Do not sync** | Never allow Git Sync Vault's own `data.json`; do not selectively allow any third-party plugin data. |
| `themes/`, `snippets/`, caches and transient files | Installed assets or local/generated state, rather than the reviewed preferences themselves. | **Device-specific / do not sync** | Remain covered by the broad config exclusion. |

## Conflict and security model

The existing exclusion patterns are unchanged. A small central predicate first
applies an unconditional denial to Git Sync Vault's credential-bearing
`data.json`, then lets only the three exact reviewed filenames bypass a broad
user exclusion such as `.obsidian/*`. There is no ordering or negated-glob
behavior and no arbitrary file picker.

Once selected, these JSON files use exactly the normal Git staging, fetch,
merge, conflict UI, non-forced push, and recovery behavior used by vault notes.
Consequently, simultaneous edits are not resolved last-writer-wins: a textual
merge is accepted only when Git can merge it, and overlapping edits are shown
as a conflict without silently choosing either device. Obsidian rewrites during
a sync remain ordinary concurrent working-tree changes and fail visibly under
the existing dirty-file safeguards; this feature adds no special retry loop.

## Recommended desktop setup

Keep the broad `Vault.configDir/*` exclusion. Enable **Files & links** on all
three desktop devices after first making `app.json` identical. Set
`attachmentFolderPath` to `Attachments`, `newLinkFormat` to the vault-root/path
form, `alwaysUpdateLinks` to true, and `useMarkdownLinks` to false in Obsidian.
Enable **Hotkeys** only if shortcuts use `Mod` where portability matters and the
same commands/plugins exist everywhere. Enable **Appearance** only after the
same theme, fonts, and snippets are installed independently on every device.
Leave workspace, core-plugin configuration, and all plugin data local.
