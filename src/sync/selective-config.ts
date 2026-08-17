import type { PluginSettings } from "../types";
import { matchesExcludePattern, normalizeGitPath } from "./paths";

export type SelectiveConfigSettings = Pick<
  PluginSettings,
  "syncObsidianFilesAndLinks" | "syncObsidianHotkeys" | "syncObsidianAppearance"
>;

export const SELECTIVE_CONFIG_FILES = {
  syncObsidianFilesAndLinks: { filename: "app.json", label: "Files & links" },
  syncObsidianHotkeys: { filename: "hotkeys.json", label: "Hotkeys" },
  syncObsidianAppearance: { filename: "appearance.json", label: "Appearance" },
} as const;

export type SelectiveConfigKey = keyof typeof SELECTIVE_CONFIG_FILES;
export type SelectiveConfigFilename = typeof SELECTIVE_CONFIG_FILES[SelectiveConfigKey]["filename"];

/** The complete, reviewed allow-list. Never accept user-provided config filenames here. */
export function selectedConfigPaths(
  configDir: string,
  settings: SelectiveConfigSettings
): Set<string> {
  const root = normalizeGitPath(configDir);
  const paths = new Set<string>();
  if (settings.syncObsidianFilesAndLinks) paths.add(`${root}/app.json`);
  if (settings.syncObsidianHotkeys) paths.add(`${root}/hotkeys.json`);
  if (settings.syncObsidianAppearance) paths.add(`${root}/appearance.json`);
  return paths;
}

/**
 * Central selective-config predicate. A reviewed file may bypass user patterns,
 * while this plugin's credential-bearing data file is an unconditional deny.
 */
export function isSelectivelyExcluded(
  filepath: string,
  configDir: string,
  pluginId: string,
  settings: SelectiveConfigSettings,
  excludePatterns: readonly string[]
): boolean {
  const path = normalizeGitPath(filepath);
  const root = normalizeGitPath(configDir);
  if (path === `${root}/plugins/${pluginId}/data.json`) return true;
  if (selectedConfigPaths(root, settings).has(path)) return false;
  // `.obsidian/*` is the persisted default/recommended intent, not an internal
  // assumption about the vault. Preserve that intent for custom config dirs.
  if (excludePatterns.includes(".obsidian/*") && path.startsWith(`${root}/`)) return true;
  return excludePatterns.some((pattern) => matchesExcludePattern(path, pattern));
}
