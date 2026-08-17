import assert from "node:assert/strict";
import test from "node:test";
import { isSelectivelyExcluded, selectedConfigPaths } from "../src/sync/selective-config";

const off = {
  syncObsidianFilesAndLinks: false,
  syncObsidianHotkeys: false,
  syncObsidianAppearance: false,
};

function excluded(path: string, configDir = ".obsidian", overrides = {}) {
  return isSelectivelyExcluded(
    path,
    configDir,
    "gitsyncvault",
    { ...off, ...overrides },
    [`${configDir}/*`]
  );
}

test("only explicitly selected reviewed config files bypass the broad exclusion", () => {
  assert.equal(excluded(".obsidian/app.json", ".obsidian", { syncObsidianFilesAndLinks: true }), false);
  assert.equal(excluded(".obsidian/hotkeys.json"), true);
  assert.equal(excluded(".obsidian/appearance.json"), true);
  assert.equal(excluded(".obsidian/workspace.json", ".obsidian", { syncObsidianFilesAndLinks: true }), true);
  assert.equal(excluded(".obsidian/plugins/calendar/data.json", ".obsidian", { syncObsidianFilesAndLinks: true }), true);
});

test("Git Sync Vault credentials are unconditionally excluded", () => {
  const allOn = {
    syncObsidianFilesAndLinks: true,
    syncObsidianHotkeys: true,
    syncObsidianAppearance: true,
  };
  assert.equal(isSelectivelyExcluded(".obsidian/plugins/gitsyncvault/data.json", ".obsidian", "gitsyncvault", allOn, []), true);
  assert.equal(isSelectivelyExcluded(".obsidian\\plugins\\gitsyncvault\\data.json", ".obsidian", "gitsyncvault", allOn, []), true);
});

test("Vault.configDir values and Windows-style paths are normalized", () => {
  const enabled = { ...off, syncObsidianFilesAndLinks: true };
  assert.deepEqual([...selectedConfigPaths(".config", enabled)], [".config/app.json"]);
  assert.equal(excluded(".config\\app.json", ".config", enabled), false);
  assert.equal(excluded(".obsidian/app.json", ".config", enabled), false); // outside the custom config directory
  assert.equal(excluded(".config/plugins/example/data.json", ".config", enabled), true);
  assert.equal(isSelectivelyExcluded(".config/workspace.json", ".config", "gitsyncvault", enabled, [".obsidian/*"]), true);
});
