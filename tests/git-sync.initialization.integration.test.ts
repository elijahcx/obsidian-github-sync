import test from "node:test";
import assert from "node:assert/strict";
import { git, makeDevice, withEmptyRemote } from "./helpers/harness";

test("create-repo flow initializes newly created empty remote with main and first note", async () => {
  await withEmptyRemote(async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "first-device");
    await device.write("note.md", "first note\n");
    await device.write(".obsidian/workspace.json", "device local\n");

    await device.sync.initAndPush(["note.md", ".obsidian/workspace.json"]);

    const localMain = await git(["rev-parse", "refs/heads/main"], device.dir);
    const remoteMain = await git(["--git-dir", remote.remotePath, "rev-parse", "refs/heads/main"]);
    assert.equal(localMain, remoteMain);
    assert.equal(await git(["--git-dir", remote.remotePath, "show", "main:note.md"]), "first note");
    await assert.rejects(git(["--git-dir", remote.remotePath, "show", "main:.obsidian/workspace.json"]));
  });
});

test("initAndPush initializes an already-existing empty remote", async () => {
  await withEmptyRemote(async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "existing-empty-remote");
    await device.write("existing.md", "existing empty remote\n");
    await device.sync.initAndPush(["existing.md"]);
    assert.equal(
      await git(["--git-dir", remote.remotePath, "show", "main:existing.md"]),
      "existing empty remote"
    );
  });
});

test("initAndPush supports an empty vault and creates an empty initial commit on main", async () => {
  await withEmptyRemote(async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "empty-vault");
    await device.sync.initAndPush([]);
    const localMain = await git(["rev-parse", "refs/heads/main"], device.dir);
    const remoteMain = await git(["--git-dir", remote.remotePath, "rev-parse", "refs/heads/main"]);
    assert.equal(localMain, remoteMain);
    assert.equal(await git(["--git-dir", remote.remotePath, "ls-tree", "-r", "--name-only", "main"]), "");
  });
});

test("initAndPush retries safely after a failed setup left a partial git directory", async () => {
  await withEmptyRemote(async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "partial-init");
    await device.write("note.md", "retry note\n");
    await git(["init", "--initial-branch=main"], device.dir);

    await device.sync.initAndPush(["note.md"]);

    const localMain = await git(["rev-parse", "refs/heads/main"], device.dir);
    const remoteMain = await git(["--git-dir", remote.remotePath, "rev-parse", "refs/heads/main"]);
    assert.equal(localMain, remoteMain);
    assert.equal(await git(["--git-dir", remote.remotePath, "show", "main:note.md"]), "retry note");
  });
});
