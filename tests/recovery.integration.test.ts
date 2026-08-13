import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { GitSync } from "../src/sync/git-sync";
import { exclude, git, makeDevice, withRemote } from "./helpers/harness";

const recoveryDir = (dir: string) => path.join(dir, ".git/obsidian-sync-recovery");

async function writeRecovery(
  dir: string,
  filepath: string,
  original: Uint8Array | null,
  heads: { local: string; remote: string }
): Promise<void> {
  const directory = recoveryDir(dir);
  await mkdir(directory, { recursive: true });
  const file = original === null ? undefined : "snapshot-0.bin";
  if (file && original !== null) await writeFile(path.join(directory, file), original);
  await writeFile(path.join(directory, "journal.json"), JSON.stringify({
    version: 1,
    operationId: "simulated-crash",
    operation: "excluded-working-tree",
    phase: "snapshotted",
    localHead: heads.local,
    remoteHead: heads.remote,
    timestamp: new Date(0).toISOString(),
    snapshots: [{ path: filepath, existed: original !== null, file }],
  }));
}

function freshSync(device: Awaited<ReturnType<typeof makeDevice>>, remoteUrl: string): GitSync {
  const sync = new GitSync(device.adapter as never, device.dir, "token", "test-user", "remote", exclude);
  (sync as unknown as { remoteUrl: string }).remoteUrl = remoteUrl;
  return sync;
}

test("startup restores an excluded snapshot before an interrupted merge writes it", async () => {
  const original = Buffer.from("device-local\n");
  await withRemote({ "note.md": "base\n", ".obsidian/workspace.json": "remote\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "recovery-before-merge");
    await device.sync.clone();
    await device.writeBinary(".obsidian/workspace.json", original);
    const head = await git(["rev-parse", "main"], device.dir);
    await writeRecovery(device.dir, ".obsidian/workspace.json", original, { local: head, remote: head });

    const result = await freshSync(device, remote.url).sync([]);
    assert.equal(result.success, true, result.error);
    assert.deepEqual(await device.readBinary(".obsidian/workspace.json"), original);
    await assert.rejects(stat(path.join(recoveryDir(device.dir), "journal.json")));
  });
});

test("startup restores binary excluded content after Git wrote the remote version", async () => {
  const original = Buffer.from([0, 255, 1, 0, 42]);
  const remoteBytes = Buffer.from([9, 8, 7, 0]);
  await withRemote({ ".obsidian/cache.bin": remoteBytes, "note.md": "base\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "recovery-after-write");
    await device.sync.clone();
    await device.writeBinary(".obsidian/cache.bin", remoteBytes);
    const head = await git(["rev-parse", "main"], device.dir);
    await writeRecovery(device.dir, ".obsidian/cache.bin", original, { local: head, remote: head });

    await freshSync(device, remote.url).pull();
    assert.deepEqual(await device.readBinary(".obsidian/cache.bin"), original);
    await assert.rejects(stat(path.join(recoveryDir(device.dir), "journal.json")));
  });
});

test("an interrupted clean merge is reconciled from actual refs after restoration", async () => {
  await withRemote({ "base.md": "base\n", ".obsidian/workspace.json": "remote\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "merge-source");
    const b = await makeDevice(remote.url, root, "merge-recovery");
    await a.sync.clone();
    await b.sync.clone();
    await b.write(".obsidian/workspace.json", "device-local\n");
    await a.write("remote.md", "advanced\n");
    assert.equal((await a.sync.sync(["remote.md"])).success, true);

    const oldHead = await git(["rev-parse", "main"], b.dir);
    await git(["fetch", remote.remotePath, "main"], b.dir);
    const remoteHead = await git(["rev-parse", "FETCH_HEAD"], b.dir);
    await writeRecovery(b.dir, ".obsidian/workspace.json", Buffer.from("device-local\n"), {
      local: oldHead, remote: remoteHead,
    });
    await b.adapter.remove(".obsidian/workspace.json");
    await git(["merge", "--ff-only", remoteHead], b.dir);

    const result = await freshSync(b, remote.url).sync([]);
    assert.equal(result.success, true, result.error);
    assert.equal(await b.read("remote.md"), "advanced\n");
    assert.equal(await b.read(".obsidian/workspace.json"), "device-local\n");
  });
});

test("old conflict sessions cannot be reused by a fresh GitSync instance", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "conflict-source");
    const b = await makeDevice(remote.url, root, "conflict-restart");
    await a.sync.clone();
    await b.sync.clone();
    await a.write("note.md", "A\n");
    await b.write("note.md", "B\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const old = (await b.sync.sync(["note.md"])).conflictFiles[0];

    const result = await freshSync(b, remote.url).resolveConflict(old.path, old.ours, old.conflictSessionId);
    assert.equal(result.stale, true);
  });
});

test("an interrupted push is recovered by observing actual remote and local refs", async () => {
  await withRemote({ "base.md": "base\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "push-recovery");
    await device.sync.clone();
    await device.write("local.md", "committed before crash\n");
    await git(["add", "local.md"], device.dir);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "interrupted push"], device.dir);

    const result = await freshSync(device, remote.url).sync([]);
    assert.equal(result.success, true, result.error);
    const verifier = await makeDevice(remote.url, root, "push-verifier");
    await verifier.sync.clone();
    assert.equal(await verifier.read("local.md"), "committed before crash\n");
  });
});

test("incomplete clone setup can safely finish without deleting working files", async () => {
  await withRemote({ "remote.md": "remote\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "partial-clone");
    await device.write("local-untracked.md", "preserve\n");
    await git(["init", "--initial-branch=main"], device.dir);
    const sync = freshSync(device, remote.url);
    assert.equal(await sync.clone(), true);
    assert.equal(await device.read("remote.md"), "remote\n");
    assert.equal(await device.read("local-untracked.md"), "preserve\n");
  });
});

test("corrupted and unsupported journals fail conservatively without changing files", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "bad-journal");
    await device.sync.clone();
    await device.write(".obsidian/workspace.json", "preserve\n");
    await mkdir(recoveryDir(device.dir), { recursive: true });
    await writeFile(path.join(recoveryDir(device.dir), "journal.json"), "{bad json");
    await assert.rejects(freshSync(device, remote.url).pull(), /journal is corrupted/);
    assert.equal(await device.read(".obsidian/workspace.json"), "preserve\n");

    await writeFile(path.join(recoveryDir(device.dir), "journal.json"), JSON.stringify({ version: 999 }));
    await assert.rejects(freshSync(device, remote.url).pull(), /Unsupported sync recovery journal/);
    assert.equal(await readFile(path.join(device.dir, ".obsidian/workspace.json"), "utf8"), "preserve\n");
  });
});
