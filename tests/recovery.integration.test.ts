import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  const file = original === null ? undefined : "1700000000000-test-0.bin";
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
    await writeFile(path.join(recoveryDir(device.dir), "orphan.bin"), "inspect me");
    await writeFile(path.join(recoveryDir(device.dir), "journal.json"), "{bad json");
    await assert.rejects(freshSync(device, remote.url).pull(), /journal is corrupted/);
    assert.equal(await device.read(".obsidian/workspace.json"), "preserve\n");

    await writeFile(path.join(recoveryDir(device.dir), "journal.json"), JSON.stringify({ version: 999 }));
    await assert.rejects(freshSync(device, remote.url).pull(), /Unsupported sync recovery journal/);
    assert.equal(await readFile(path.join(device.dir, ".obsidian/workspace.json"), "utf8"), "preserve\n");
    assert.equal(await readFile(path.join(recoveryDir(device.dir), "orphan.bin"), "utf8"), "inspect me");
  });
});

test("startup removes only unreferenced recovery snapshot blobs", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "orphan-cleanup");
    await device.sync.clone();
    await mkdir(recoveryDir(device.dir), { recursive: true });
    await writeFile(path.join(recoveryDir(device.dir), "1700000000000-orphan-0.bin"), "orphan");
    await writeFile(path.join(recoveryDir(device.dir), "user-backup.bin"), "preserve");
    await writeFile(path.join(recoveryDir(device.dir), "keep.txt"), "not a snapshot");
    assert.equal((await freshSync(device, remote.url).sync([])).success, true);
    await assert.rejects(stat(path.join(recoveryDir(device.dir), "1700000000000-orphan-0.bin")));
    assert.equal(await readFile(path.join(recoveryDir(device.dir), "user-backup.bin"), "utf8"), "preserve");
    assert.equal(await readFile(path.join(recoveryDir(device.dir), "keep.txt"), "utf8"), "not a snapshot");
  });
});

test("recovery cleanup propagates marker and snapshot deletion failures and remains restart-safe", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "cleanup-failures");
    await device.sync.clone();
    await device.write(".obsidian/workspace.json", "local\n");
    const head = await git(["rev-parse", "main"], device.dir);
    await writeRecovery(device.dir, ".obsidian/workspace.json", Buffer.from("local\n"), { local: head, remote: head });
    const originalRemove = device.adapter.remove.bind(device.adapter);
    let failJournal = true;
    device.adapter.remove = async (filepath) => {
      if (failJournal && filepath.endsWith("journal.json")) {
        throw Object.assign(new Error("journal remove denied"), { code: "EACCES" });
      }
      return originalRemove(filepath);
    };
    await assert.rejects(freshSync(device, remote.url).sync([]), /journal remove denied/);
    assert.equal(await device.read(".obsidian/workspace.json"), "local\n");
    await stat(path.join(recoveryDir(device.dir), "journal.json"));
    await stat(path.join(recoveryDir(device.dir), "1700000000000-test-0.bin"));

    failJournal = false;
    let failSnapshot = true;
    device.adapter.remove = async (filepath) => {
      if (failSnapshot && filepath.endsWith("1700000000000-test-0.bin")) {
        throw Object.assign(new Error("snapshot remove denied"), { code: "EACCES" });
      }
      return originalRemove(filepath);
    };
    await assert.rejects(freshSync(device, remote.url).sync([]), /snapshot remove denied/);
    await assert.rejects(stat(path.join(recoveryDir(device.dir), "journal.json")));
    await stat(path.join(recoveryDir(device.dir), "1700000000000-test-0.bin"));

    failSnapshot = false;
    device.adapter.remove = originalRemove;
    assert.equal((await freshSync(device, remote.url).sync([])).success, true);
    await assert.rejects(stat(path.join(recoveryDir(device.dir), "1700000000000-test-0.bin")));
  });
});

test("interrupted checkout is reconciled on restart only when working files still match the old head", async () => {
  await withRemote({ "note.md": "old\n" }, async ({ remote, root }) => {
    const source = await makeDevice(remote.url, root, "checkout-recovery-source");
    const device = await makeDevice(remote.url, root, "checkout-recovery-device");
    await source.sync.clone(); await device.sync.clone();
    const beforeHead = await git(["rev-parse", "main"], device.dir);
    await source.write("note.md", "remote\n");
    assert.equal((await source.sync.sync(["note.md"])).success, true);
    await git(["fetch", remote.url, "main"], device.dir);
    const afterHead = await git(["rev-parse", "FETCH_HEAD"], device.dir);
    await git(["update-ref", "refs/heads/main", afterHead], device.dir);
    await device.write("note.md", "old\n");
    const oldStats = await stat(path.join(device.dir, "note.md"));
    const markerPath = { path: "note.md", existed: true, size: oldStats.size, mtimeMs: oldStats.mtimeMs };
    await mkdir(recoveryDir(device.dir), { recursive: true });
    await writeFile(path.join(recoveryDir(device.dir), "checkout.json"), JSON.stringify({
      version: 1, beforeHead, afterHead, paths: [markerPath],
    }));

    const originalRemove = device.adapter.remove.bind(device.adapter);
    let failMarkerRemoval = true;
    device.adapter.remove = async (filepath) => {
      if (failMarkerRemoval && filepath.endsWith("checkout.json")) {
        throw Object.assign(new Error("checkout marker remove denied"), { code: "EACCES" });
      }
      return originalRemove(filepath);
    };
    await assert.rejects(freshSync(device, remote.url).sync([]), /checkout marker remove denied/);
    assert.equal(await device.read("note.md"), "remote\n");
    await stat(path.join(recoveryDir(device.dir), "checkout.json"));
    failMarkerRemoval = false;
    device.adapter.remove = originalRemove;
    const recovered = await freshSync(device, remote.url).sync([]);
    assert.equal(recovered.success, true, recovered.error);
    assert.equal(await device.read("note.md"), "remote\n");
    await assert.rejects(stat(path.join(recoveryDir(device.dir), "checkout.json")));

    await device.write("note.md", "dirty user edit\n");
    await writeFile(path.join(recoveryDir(device.dir), "checkout.json"), JSON.stringify({
      version: 1, beforeHead, afterHead, paths: [markerPath],
    }));
    await assert.rejects(
      freshSync(device, remote.url).sync([]),
      /preserve dirty local file/
    );
    assert.equal(await device.read("note.md"), "dirty user edit\n");
    assert.equal(await git(["--git-dir", remote.remotePath, "rev-parse", "main"]), afterHead);
  });
});

test("checkout marker rejects malformed, duplicate, unchanged, unrelated, oversized, and symlink content", async () => {
  await withRemote({ "note.md": "old\n", "unchanged.md": "same\n", "dir/file.md": "old\n" }, async ({ remote, root }) => {
    const source = await makeDevice(remote.url, root, "marker-source");
    const device = await makeDevice(remote.url, root, "marker-device");
    await source.sync.clone(); await device.sync.clone();
    const beforeHead = await git(["rev-parse", "main"], device.dir);
    await source.write("note.md", "new\n");
    await source.write("dir/file.md", "new\n");
    assert.equal((await source.sync.sync(["note.md", "dir/file.md"])).success, true);
    await git(["fetch", remote.url, "main"], device.dir);
    const afterHead = await git(["rev-parse", "FETCH_HEAD"], device.dir);
    await git(["update-ref", "refs/heads/main", afterHead], device.dir);
    const noteStats = await stat(path.join(device.dir, "note.md"));
    const note = { path: "note.md", existed: true, size: noteStats.size, mtimeMs: noteStats.mtimeMs };
    await mkdir(recoveryDir(device.dir), { recursive: true });
    const marker = (value: unknown) => writeFile(
      path.join(recoveryDir(device.dir), "checkout.json"), JSON.stringify(value)
    );

    await marker({ version: 1, beforeHead: "bad", afterHead, paths: [note] });
    await assert.rejects(freshSync(device, remote.url).sync([]), /unsafe|invalid/i);
    await marker({ version: 1, beforeHead, afterHead, paths: [note, note] });
    await assert.rejects(freshSync(device, remote.url).sync([]), /duplicate/);
    await marker({ version: 1, beforeHead, afterHead, paths: [{ ...note, path: "unchanged.md" }] });
    await assert.rejects(freshSync(device, remote.url).sync([]), /unchanged/);

    const tree = await git(["rev-parse", `${afterHead}^{tree}`], device.dir);
    const unrelated = await git([
      "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit-tree", tree, "-m", "unrelated",
    ], device.dir);
    await marker({ version: 1, beforeHead: unrelated, afterHead, paths: [note] });
    await assert.rejects(freshSync(device, remote.url).sync([]), /unrelated/);

    await writeFile(path.join(recoveryDir(device.dir), "checkout.json"), "x".repeat(1_000_001));
    await assert.rejects(freshSync(device, remote.url).sync([]), /oversized/);

    await marker({
      version: 1, beforeHead, afterHead,
      paths: [{ ...note, path: "dir/file.md" }],
    });
    await rm(path.join(device.dir, "dir"), { recursive: true });
    await symlink(root, path.join(device.dir, "dir"), "dir");
    await assert.rejects(freshSync(device, remote.url).sync([]), /symlink/);
  });
});

test("checkout recovery handles added and deleted files", async () => {
  await withRemote({ "deleted.md": "remove me\n" }, async ({ remote, root }) => {
    const source = await makeDevice(remote.url, root, "add-delete-source");
    const device = await makeDevice(remote.url, root, "add-delete-device");
    await source.sync.clone(); await device.sync.clone();
    const beforeHead = await git(["rev-parse", "main"], device.dir);
    const deletedStats = await stat(path.join(device.dir, "deleted.md"));
    await source.adapter.remove("deleted.md");
    await source.write("added.md", "added\n");
    assert.equal((await source.sync.sync(["deleted.md", "added.md"])).success, true);
    await git(["fetch", remote.url, "main"], device.dir);
    const afterHead = await git(["rev-parse", "FETCH_HEAD"], device.dir);
    await git(["update-ref", "refs/heads/main", afterHead], device.dir);
    await mkdir(recoveryDir(device.dir), { recursive: true });
    await writeFile(path.join(recoveryDir(device.dir), "checkout.json"), JSON.stringify({
      version: 1, beforeHead, afterHead, paths: [
        { path: "added.md", existed: false, size: 0, mtimeMs: null },
        { path: "deleted.md", existed: true, size: deletedStats.size, mtimeMs: deletedStats.mtimeMs },
      ],
    }));
    assert.equal((await freshSync(device, remote.url).sync([])).success, true);
    assert.equal(await device.read("added.md"), "added\n");
    await assert.rejects(device.read("deleted.md"));
  });
});
