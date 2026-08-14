import test from "node:test";
import assert from "node:assert/strict";
import { git, makeDevice, withEmptyRemote } from "./helpers/harness";

async function createLocalMain(device: Awaited<ReturnType<typeof makeDevice>>, remoteUrl: string): Promise<string> {
  await device.write("note.md", "local initial history\n");
  await git(["init", "--initial-branch=main"], device.dir);
  await git(["config", "user.name", "Test"], device.dir);
  await git(["config", "user.email", "test@example.com"], device.dir);
  await git(["add", "note.md"], device.dir);
  await git(["commit", "-m", "local initial commit"], device.dir);
  await git(["remote", "add", "origin", remoteUrl], device.dir);
  return git(["rev-parse", "refs/heads/main"], device.dir);
}

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

test("sync treats a reachable empty remote as empty and performs the first non-forced push", async () => {
  await withEmptyRemote(async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "reconnect-empty-remote");
    const localMain = await createLocalMain(device, remote.url);
    await assert.rejects(git(["rev-parse", "refs/remotes/origin/main"], device.dir));

    const first = await device.sync.sync([]);
    assert.equal(first.success, true, first.error);
    assert.equal(first.logs?.some((line) => line.includes("fetch failed")), false);
    assert.equal(
      await git(["--git-dir", remote.remotePath, "rev-parse", "refs/heads/main"]),
      localMain
    );
    assert.equal(
      await git(["--git-dir", remote.remotePath, "show", "main:note.md"]),
      "local initial history"
    );

    const second = await device.sync.sync([]);
    assert.equal(second.success, true, second.error);
    assert.equal(await git(["rev-parse", "refs/remotes/origin/main"], device.dir), localMain);
  });
});

test("authentication and repository-not-found responses remain genuine fetch failures", async () => {
  for (const [status, expected] of [[401, /HttpError|401|authentication/i], [404, /HttpError|404|not found/i]] as const) {
    await withEmptyRemote(async ({ remote, root }) => {
      const device = await makeDevice(remote.url, root, `fetch-error-${status}`);
      await createLocalMain(device, remote.url);
      remote.setFailureStatus(status);
      const result = await device.sync.sync([]);
      assert.equal(result.success, false);
      assert.match(result.error ?? "", expected);
      await assert.rejects(git(["--git-dir", remote.remotePath, "rev-parse", "refs/heads/main"]));
    });
  }
});

test("populated remote fetch behavior remains unchanged", async () => {
  await withEmptyRemote(async ({ remote, root }) => {
    const source = await makeDevice(remote.url, root, "populated-source");
    await source.write("remote.md", "populated\n");
    await source.sync.initAndPush(["remote.md"]);

    const device = await makeDevice(remote.url, root, "populated-device");
    assert.equal(await device.sync.clone(), true);
    const result = await device.sync.sync([]);
    assert.equal(result.success, true, result.error);
    assert.equal(await device.read("remote.md"), "populated\n");
  });
});
