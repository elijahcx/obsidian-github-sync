import assert from "node:assert/strict";
import test from "node:test";
import { Notice } from "obsidian";
import MultiSyncPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/types";
import type { SelectiveConfigAdoptionChoice } from "../src/ui/selective-config-adoption-modal";

function pluginFixture(options: {
  local?: Uint8Array | null;
  remote?: Uint8Array | null;
  choice?: SelectiveConfigAdoptionChoice;
  inspectError?: Error;
  busy?: boolean;
  saveError?: Error;
  adoptError?: Error;
} = {}) {
  const plugin = Object.create(MultiSyncPlugin.prototype) as MultiSyncPlugin & Record<string, unknown>;
  let saves = 0;
  let adoptions = 0;
  let prompts = 0;
  let restores = 0;
  const settings = { ...DEFAULT_SETTINGS, autoSync: false };
  Object.assign(plugin, {
    settings,
    foregroundOperations: options.busy ? 1 : 0,
    conflictActive: false,
    selectiveConfigAdoptionActive: false,
    remotePoller: null,
    syncQueue: { isIdleForRemotePull: () => true },
    gitSync: {
      inspectSelectiveConfig: async () => {
        if (options.inspectError) throw options.inspectError;
        return { local: options.local ?? null, remote: options.remote ?? null };
      },
      adoptSelectiveConfigRemote: async () => {
        adoptions++;
        if (options.adoptError) throw options.adoptError;
      },
      restoreSelectiveConfigAfterPersistenceFailure: async () => { restores++; },
    },
    saveSettings: async () => { saves++; if (options.saveError) throw options.saveError; },
    chooseSelectiveConfigVersion: async () => { prompts++; return options.choice ?? "cancel"; },
  });
  return { plugin, settings, counts: () => ({ saves, adoptions, prompts, restores }) };
}

test("unambiguous enable persists once without a prompt", async () => {
  for (const state of [
    { local: new Uint8Array([1]), remote: null },
    { local: null, remote: null },
    { local: new Uint8Array([1, 2]), remote: new Uint8Array([1, 2]) },
  ]) {
    const fixture = pluginFixture(state);
    assert.equal(await fixture.plugin.requestSelectiveConfigChange("syncObsidianFilesAndLinks", true), true);
    assert.equal(fixture.settings.syncObsidianFilesAndLinks, true);
    assert.deepEqual(fixture.counts(), { saves: 1, adoptions: 0, prompts: 0, restores: 0 });
  }
});

test("remote-only enable materializes before persisting", async () => {
  const fixture = pluginFixture({ local: null, remote: new Uint8Array([9]) });
  assert.equal(await fixture.plugin.requestSelectiveConfigChange("syncObsidianFilesAndLinks", true), true);
  assert.equal(fixture.settings.syncObsidianFilesAndLinks, true);
  assert.deepEqual(fixture.counts(), { saves: 1, adoptions: 1, prompts: 0, restores: 0 });
});

test("differing bytes require one explicit choice", async () => {
  const synced = pluginFixture({ local: new Uint8Array([1]), remote: new Uint8Array([2]), choice: "synced" });
  assert.equal(await synced.plugin.requestSelectiveConfigChange("syncObsidianFilesAndLinks", true), true);
  assert.deepEqual(synced.counts(), { saves: 1, adoptions: 1, prompts: 1, restores: 0 });

  const local = pluginFixture({ local: new Uint8Array([1]), remote: new Uint8Array([2]), choice: "local" });
  assert.equal(await local.plugin.requestSelectiveConfigChange("syncObsidianFilesAndLinks", true), true);
  assert.deepEqual(local.counts(), { saves: 1, adoptions: 0, prompts: 1, restores: 0 });

  const cancel = pluginFixture({ local: new Uint8Array([1]), remote: new Uint8Array([2]), choice: "cancel" });
  assert.equal(await cancel.plugin.requestSelectiveConfigChange("syncObsidianFilesAndLinks", true), false);
  assert.equal(cancel.settings.syncObsidianFilesAndLinks, false);
  assert.deepEqual(cancel.counts(), { saves: 0, adoptions: 0, prompts: 1, restores: 0 });
});

test("offline failures and active operations keep the category off", async () => {
  const messages = (Notice as unknown as { messages: string[] }).messages;
  messages.length = 0;
  const offline = pluginFixture({ inspectError: new Error("fetch unavailable") });
  assert.equal(await offline.plugin.requestSelectiveConfigChange("syncObsidianFilesAndLinks", true), false);
  assert.equal(offline.settings.syncObsidianFilesAndLinks, false);
  assert.match(messages.at(-1) ?? "", /Could not enable Files & links settings sync/);

  const busy = pluginFixture({ busy: true });
  assert.equal(await busy.plugin.requestSelectiveConfigChange("syncObsidianFilesAndLinks", true), false);
  assert.equal(busy.settings.syncObsidianFilesAndLinks, false);
  assert.deepEqual(busy.counts(), { saves: 0, adoptions: 0, prompts: 0, restores: 0 });
});

test("duplicate adoption requests are refused", async () => {
  const fixture = pluginFixture();
  (fixture.plugin as unknown as { selectiveConfigAdoptionActive: boolean }).selectiveConfigAdoptionActive = true;
  assert.equal(await fixture.plugin.requestSelectiveConfigChange("syncObsidianFilesAndLinks", true), false);
  assert.deepEqual(fixture.counts(), { saves: 0, adoptions: 0, prompts: 0, restores: 0 });
});

test("settings persistence failure rolls back a materialized remote file", async () => {
  const fixture = pluginFixture({
    local: null,
    remote: new Uint8Array([9]),
    saveError: new Error("storage failed"),
  });
  assert.equal(await fixture.plugin.requestSelectiveConfigChange("syncObsidianFilesAndLinks", true), false);
  assert.equal(fixture.settings.syncObsidianFilesAndLinks, false);
  assert.deepEqual(fixture.counts(), { saves: 1, adoptions: 1, prompts: 0, restores: 1 });
});

test("provider replacement failure leaves the category off", async () => {
  const fixture = pluginFixture({
    local: new Uint8Array([1]),
    remote: new Uint8Array([2]),
    choice: "synced",
    adoptError: new Error("provider replacement failed"),
  });
  assert.equal(await fixture.plugin.requestSelectiveConfigChange("syncObsidianFilesAndLinks", true), false);
  assert.equal(fixture.settings.syncObsidianFilesAndLinks, false);
  assert.deepEqual(fixture.counts(), { saves: 0, adoptions: 1, prompts: 1, restores: 0 });
});
