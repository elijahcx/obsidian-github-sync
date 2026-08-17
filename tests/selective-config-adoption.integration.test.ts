import assert from "node:assert/strict";
import test from "node:test";
import { isSelectivelyExcluded } from "../src/sync/selective-config";
import { git, makeDevice, withRemote } from "./helpers/harness";

const off = {
  syncObsidianFilesAndLinks: false,
  syncObsidianHotkeys: false,
  syncObsidianAppearance: false,
};
const on = { ...off, syncObsidianFilesAndLinks: true };
const exclusion = (configDir: string, enabled: typeof off) => (path: string) =>
  isSelectivelyExcluded(path, configDir, "gitsyncvault", enabled, [".obsidian/*"]);
const text = (bytes: Uint8Array | null) => bytes === null ? null : Buffer.from(bytes).toString("utf8");

test("first device and empty-both inspection need no adoption choice", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const local = await makeDevice(remote.url, root, "first-local", exclusion(".obsidian", off));
    await local.sync.clone();
    await local.write(".obsidian/app.json", "local settings\n");
    assert.deepEqual(
      { ...await local.sync.inspectSelectiveConfig("app.json"), local: text((await local.sync.inspectSelectiveConfig("app.json")).local) },
      { local: "local settings\n", remote: null }
    );

    const empty = await makeDevice(remote.url, root, "first-empty", exclusion(".obsidian", off));
    await empty.sync.clone();
    const snapshot = await empty.sync.inspectSelectiveConfig("app.json");
    assert.equal(snapshot.local, null);
    assert.equal(snapshot.remote, null);
  });
});

test("remote-only and identical settings are determined by exact bytes", async () => {
  await withRemote({ ".obsidian/app.json": new Uint8Array([0, 1, 2, 255]) }, async ({ remote, root }) => {
    const remoteOnly = await makeDevice(remote.url, root, "remote-only", exclusion(".obsidian", off));
    await remoteOnly.sync.clone();
    const snapshot = await remoteOnly.sync.inspectSelectiveConfig("app.json");
    assert.equal(snapshot.local, null);
    assert.deepEqual(snapshot.remote, new Uint8Array([0, 1, 2, 255]));
    await remoteOnly.sync.adoptSelectiveConfigRemote("app.json", snapshot.local, snapshot.remote!);
    assert.deepEqual(await remoteOnly.readBinary(".obsidian/app.json"), Buffer.from([0, 1, 2, 255]));

    const identical = await makeDevice(remote.url, root, "identical", exclusion(".obsidian", off));
    await identical.sync.clone();
    await identical.writeBinary(".obsidian/app.json", new Uint8Array([0, 1, 2, 255]));
    const same = await identical.sync.inspectSelectiveConfig("app.json");
    assert.deepEqual(same.local, same.remote);
  });
});

test("differing device can adopt synced bytes without a push", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const deviceA = await makeDevice(remote.url, root, "publish-a", exclusion(".obsidian", on));
    await deviceA.sync.clone();
    await deviceA.write(".obsidian/app.json", "device A\n");
    assert.equal((await deviceA.sync.sync([".obsidian/app.json"])).success, true);
    const deviceB = await makeDevice(remote.url, root, "adopt-synced", exclusion(".obsidian", off));
    await deviceB.write(".obsidian/app.json", "device B\n");
    await deviceB.sync.clone();
    const before = await git(["--git-dir", remote.remotePath, "rev-parse", "main"]);
    const snapshot = await deviceB.sync.inspectSelectiveConfig("app.json");
    assert.equal(text(snapshot.local), "device B\n");
    assert.equal(text(snapshot.remote), "device A\n");
    await deviceB.sync.adoptSelectiveConfigRemote("app.json", snapshot.local, snapshot.remote!);
    assert.equal(await deviceB.read(".obsidian/app.json"), "device A\n");
    assert.equal(await git(["--git-dir", remote.remotePath, "rev-parse", "main"]), before);
  });
});

test("choosing this device leaves bytes for normal non-forced sync", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const deviceA = await makeDevice(remote.url, root, "publish-a-local-choice", exclusion(".obsidian", on));
    await deviceA.sync.clone();
    await deviceA.write(".obsidian/app.json", "device A\n");
    assert.equal((await deviceA.sync.sync([".obsidian/app.json"])).success, true);
    const deviceB = await makeDevice(remote.url, root, "adopt-local", exclusion(".obsidian", off));
    await deviceB.write(".obsidian/app.json", "device B\n");
    await deviceB.sync.clone();
    const snapshot = await deviceB.sync.inspectSelectiveConfig("app.json");
    assert.notDeepEqual(snapshot.local, snapshot.remote);
    assert.equal(await deviceB.read(".obsidian/app.json"), "device B\n");

    const participating = await makeDevice(remote.url, root, "adopt-local", exclusion(".obsidian", on));
    const result = await participating.sync.sync([".obsidian/app.json"]);
    assert.equal(result.success, true, result.error);
    assert.equal(await git(["--git-dir", remote.remotePath, "show", "main:.obsidian/app.json"]), "device B");
  });
});

test("a local rewrite after the choice aborts remote adoption", async () => {
  await withRemote({ ".obsidian/app.json": "remote\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "adoption-race", exclusion(".obsidian", off));
    await device.sync.clone();
    await device.write(".obsidian/app.json", "snapshot\n");
    const snapshot = await device.sync.inspectSelectiveConfig("app.json");
    await device.write(".obsidian/app.json", "newer local bytes\n");
    await assert.rejects(
      device.sync.adoptSelectiveConfigRemote("app.json", snapshot.local, snapshot.remote!),
      /Local settings changed/
    );
    assert.equal(await device.read(".obsidian/app.json"), "newer local bytes\n");
  });
});

test("custom configDir is isolated and credential data is rejected", async () => {
  await withRemote({ "config/app.json": "remote app\n", "config/hotkeys.json": "remote keys\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "custom-config", exclusion("config", off), "config");
    await device.sync.clone();
    await device.write("config/hotkeys.json", "local keys\n");
    const snapshot = await device.sync.inspectSelectiveConfig("app.json");
    await device.sync.adoptSelectiveConfigRemote("app.json", snapshot.local, snapshot.remote!);
    assert.equal(await device.read("config/app.json"), "remote app\n");
    assert.equal(await device.read("config/hotkeys.json"), "local keys\n");
    await assert.rejects(
      device.sync.inspectSelectiveConfig("plugins/gitsyncvault/data.json" as never),
      /limited to reviewed/
    );
  });
});

test("offline inspection cannot guess which settings are authoritative", async () => {
  await withRemote({ ".obsidian/app.json": "remote\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "offline-adoption", exclusion(".obsidian", off));
    await device.sync.clone();
    await device.write(".obsidian/app.json", "local\n");
    remote.setFailureStatus(401);
    await assert.rejects(device.sync.inspectSelectiveConfig("app.json"), /authentication|fetch/i);
    assert.equal(await device.read(".obsidian/app.json"), "local\n");
  });
});
