import assert from "node:assert/strict";
import test from "node:test";
import { isSelectivelyExcluded } from "../src/sync/selective-config";
import { git, makeDevice, withRemote } from "./helpers/harness";

const settings = {
  syncObsidianFilesAndLinks: true,
  syncObsidianHotkeys: false,
  syncObsidianAppearance: false,
};
const selective = (path: string) => isSelectivelyExcluded(path, ".obsidian", "gitsyncvault", settings, [".obsidian/*"]);

test("selected app.json changes sync while other config and credentials do not", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "selective", selective);
    await device.sync.clone();
    await device.write(".obsidian/app.json", JSON.stringify({ attachmentFolderPath: "Attachments" }));
    await device.write(".obsidian/hotkeys.json", "{\"secret\":false}");
    await device.write(".obsidian/plugins/gitsyncvault/data.json", "{\"githubToken\":\"secret\"}");
    const result = await device.sync.sync([
      ".obsidian/app.json",
      ".obsidian/hotkeys.json",
      ".obsidian/plugins/gitsyncvault/data.json",
    ]);
    assert.equal(result.success, true);
    assert.match(await git(["--git-dir", remote.remotePath, "show", "main:.obsidian/app.json"]), /Attachments/);
    await assert.rejects(git(["--git-dir", remote.remotePath, "show", "main:.obsidian/hotkeys.json"]));
    await assert.rejects(git(["--git-dir", remote.remotePath, "show", "main:.obsidian/plugins/gitsyncvault/data.json"]));
  });
});

test("simultaneous selected config changes surface a conflict without choosing a device", async () => {
  await withRemote({ ".obsidian/app.json": "{\"attachmentFolderPath\":\"base\"}\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "config-a", selective);
    const b = await makeDevice(remote.url, root, "config-b", selective);
    await a.sync.clone();
    await b.sync.clone();
    await a.write(".obsidian/app.json", "{\"attachmentFolderPath\":\"A\"}\n");
    assert.equal((await a.sync.sync([".obsidian/app.json"])).success, true);
    await b.write(".obsidian/app.json", "{\"attachmentFolderPath\":\"B\"}\n");
    const result = await b.sync.sync([".obsidian/app.json"]);
    assert.equal(result.success, false);
    assert.equal(result.conflictFiles.length, 1);
    assert.equal(result.conflictFiles[0].path, ".obsidian/app.json");
    assert.match(await b.read(".obsidian/app.json"), /"B"/);
  });
});
