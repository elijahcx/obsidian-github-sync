import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { GitSync } from "../src/sync/git-sync";
import { SyncQueue } from "../src/sync/queue";
import { exclude, git, makeDevice, withRemote } from "./helpers/harness";

function fresh(device: Awaited<ReturnType<typeof makeDevice>>, url: string): GitSync {
  const sync = new GitSync(device.adapter as never, device.dir, "token", "test-user", "remote", exclude);
  (sync as unknown as { remoteUrl: string }).remoteUrl = url;
  return sync;
}

async function writeJournal(dir: string, snapshots: unknown[]): Promise<void> {
  const recovery = path.join(dir, ".git/obsidian-sync-recovery");
  await mkdir(recovery, { recursive: true });
  await writeFile(path.join(recovery, "safe.bin"), "original\n");
  await writeFile(path.join(recovery, "journal.json"), JSON.stringify({
    version: 1, operationId: "test", operation: "excluded-working-tree",
    phase: "snapshotted", localHead: "a", remoteHead: "b",
    timestamp: new Date(0).toISOString(), snapshots,
  }));
}

test("recovery rejects traversal, absolute, drive, UNC, and snapshot traversal without changes", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const cases = [
      { path: ".obsidian/../../outside.txt", existed: true, file: "safe.bin" },
      { path: "/.obsidian/absolute", existed: true, file: "safe.bin" },
      { path: "C:/vault/.obsidian/file", existed: true, file: "safe.bin" },
      { path: "//server/share/.obsidian/file", existed: true, file: "safe.bin" },
      { path: ".obsidian/workspace.json", existed: true, file: "../outside.bin" },
    ];
    for (const [index, bad] of cases.entries()) {
      const device = await makeDevice(remote.url, root, `unsafe-${index}`);
      await device.sync.clone();
      await device.write(".obsidian/workspace.json", "preserve\n");
      await writeJournal(device.dir, [bad]);
      await assert.rejects(fresh(device, remote.url).pull(), /Unsafe recovery/);
      assert.equal(await device.read(".obsidian/workspace.json"), "preserve\n");
    }
  });
});

test("journal validation is all-or-nothing when a later entry is invalid", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "journal-atomic");
    await device.sync.clone();
    await device.write(".obsidian/workspace.json", "current\n");
    await writeJournal(device.dir, [
      { path: ".obsidian/workspace.json", existed: true, file: "safe.bin" },
      { path: ".obsidian/../../outside", existed: false },
    ]);
    await assert.rejects(fresh(device, remote.url).pull(), /Unsafe recovery/);
    assert.equal(await device.read(".obsidian/workspace.json"), "current\n");
  });
});

test("clone preserves differing local collision and accepts identical content", async () => {
  await withRemote({ "note.md": "remote\n" }, async ({ remote, root }) => {
    const different = await makeDevice(remote.url, root, "clone-different");
    await different.write("note.md", "local\n");
    await different.write("unrelated.md", "keep\n");
    await different.write(".obsidian/workspace.json", "local config\n");
    await assert.rejects(different.sync.clone(), /preserve differing local/);
    assert.equal(await different.read("note.md"), "local\n");
    assert.equal(await different.read("unrelated.md"), "keep\n");
    assert.equal(await different.read(".obsidian/workspace.json"), "local config\n");

    const identical = await makeDevice(remote.url, root, "clone-identical");
    await identical.write("note.md", "remote\n");
    assert.equal(await identical.sync.clone(), true);
    assert.equal(await identical.read("note.md"), "remote\n");
  });
});

test("dirty unqueued file appearing during fetch is never overwritten", async () => {
  await withRemote({ "a.md": "a0\n", "b.md": "b0\n" }, async ({ remote, root }) => {
    const source = await makeDevice(remote.url, root, "dirty-source");
    const device = await makeDevice(remote.url, root, "dirty-device");
    await source.sync.clone(); await device.sync.clone();
    await source.write("b.md", "remote b\n");
    assert.equal((await source.sync.sync(["b.md"])).success, true);
    await device.write("a.md", "local a\n");
    const internals = device.sync as never as { safeFetch: () => Promise<string | null> };
    const realFetch = internals.safeFetch.bind(device.sync);
    internals.safeFetch = async () => {
      const head = await realFetch();
      await device.write("b.md", "late local b\n");
      return head;
    };
    const result = await device.sync.sync(["a.md"]);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /changed during sync/);
    assert.equal(await device.read("b.md"), "late local b\n");
  });
});

test("checkout materialization failure fails sync and does not push local merge", async () => {
  await withRemote({ "a.md": "a0\n", "b.md": "b0\n" }, async ({ remote, root }) => {
    const source = await makeDevice(remote.url, root, "checkout-source");
    const device = await makeDevice(remote.url, root, "checkout-device");
    await source.sync.clone(); await device.sync.clone();
    await source.write("b.md", "remote b\n");
    assert.equal((await source.sync.sync(["b.md"])).success, true);
    const remoteBefore = await git(["--git-dir", remote.remotePath, "rev-parse", "main"]);
    await device.write("a.md", "local a\n");
    const fs = (device.sync as never as { fs: { promises: { writeFile: (...args: unknown[]) => Promise<void> } } }).fs;
    const original = fs.promises.writeFile.bind(fs.promises);
    fs.promises.writeFile = async (...args: unknown[]) => {
      if (String(args[0]).endsWith("/b.md")) throw Object.assign(new Error("provider write failed"), { code: "EIO" });
      return original(...args);
    };
    const statuses: string[] = [];
    const queue = new SyncQueue(device.sync, (status) => statuses.push(status), 1);
    queue.enqueue("a.md");
    const result = await queue.flushNow();
    assert.ok(result);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /checkout failed/);
    assert.deepEqual(statuses, ["pushing", "error"]);
    assert.equal(await git(["--git-dir", remote.remotePath, "rev-parse", "main"]), remoteBefore);
  });
});

test("excluded snapshot absence is allowed but real read failures abort before mutation", async () => {
  await withRemote({ ".obsidian/workspace.json": "tracked\n", "note.md": "base\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "snapshot-errors");
    await device.sync.clone();
    const head = await git(["rev-parse", "main"], device.dir);
    const internals = device.sync as never as {
      fs: { promises: { readFile: (path: string, options?: unknown) => Promise<unknown> } };
      withExcludedWorkingTreeProtected: <T>(a: string, b: string, op: () => Promise<T>) => Promise<T>;
    };
    let ran = false;
    await internals.withExcludedWorkingTreeProtected(head, head, async () => { ran = true; });
    assert.equal(ran, true);

    await device.write(".obsidian/workspace.json", "local\n");
    const originalRead = internals.fs.promises.readFile.bind(internals.fs.promises);
    for (const code of ["EACCES", "EAGAIN"]) {
      internals.fs.promises.readFile = async (p, options) => {
        if (String(p).endsWith("/.obsidian/workspace.json")) throw Object.assign(new Error(code), { code });
        return originalRead(p, options);
      };
      ran = false;
      await assert.rejects(
        internals.withExcludedWorkingTreeProtected(head, head, async () => { ran = true; }),
        new RegExp(code)
      );
      assert.equal(ran, false);
      assert.equal(await readFile(path.join(device.dir, ".obsidian/workspace.json"), "utf8"), "local\n");
    }
  });
});

async function makeDeleteModifyConflict(
  remoteUrl: string, root: string, localContent: Uint8Array | string, remoteDeletes: boolean
) {
  const a = await makeDevice(remoteUrl, root, "zero-a");
  const b = await makeDevice(remoteUrl, root, "zero-b");
  await a.sync.clone(); await b.sync.clone();
  if (remoteDeletes) await a.adapter.remove("note.md"); else await a.writeBinary("note.md", new Uint8Array());
  if (typeof localContent === "string") await b.write("note.md", localContent);
  else await b.writeBinary("note.md", localContent);
  assert.equal((await a.sync.sync(["note.md"])).success, true);
  return { b, conflict: (await b.sync.sync(["note.md"])).conflictFiles[0] };
}

test("zero-byte content and explicit deletion remain distinct in conflicts", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const localZero = await makeDeleteModifyConflict(remote.url, root, new Uint8Array(), true);
    assert.equal(localZero.conflict.oursExists, true);
    const keptZero = await localZero.b.sync.resolveConflict(localZero.conflict.path,
      { exists: true, content: new Uint8Array() }, localZero.conflict.conflictSessionId);
    assert.equal(keptZero.completed, true);
    assert.equal((await stat(path.join(localZero.b.dir, "note.md"))).size, 0);
  });
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "remote-zero-a");
    const b = await makeDevice(remote.url, root, "remote-zero-b");
    await a.sync.clone(); await b.sync.clone();
    await a.writeBinary("note.md", new Uint8Array());
    await b.adapter.remove("note.md");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const conflict = (await b.sync.sync(["note.md"])).conflictFiles[0];
    assert.equal(conflict.theirsExists, true);
    assert.equal(conflict.theirs, "");
    const kept = await b.sync.resolveConflict("note.md", { exists: true, content: "" }, conflict.conflictSessionId);
    assert.equal(kept.completed, true);
    assert.equal((await stat(path.join(b.dir, "note.md"))).size, 0);
  });
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "explicit-delete-a");
    const b = await makeDevice(remote.url, root, "explicit-delete-b");
    await a.sync.clone(); await b.sync.clone();
    await a.adapter.remove("note.md"); await b.write("note.md", "modified\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const conflict = (await b.sync.sync(["note.md"])).conflictFiles[0];
    const deleted = await b.sync.resolveConflict("note.md", { exists: false, content: "" }, conflict.conflictSessionId);
    assert.equal(deleted.completed, true);
    await assert.rejects(stat(path.join(b.dir, "note.md")));
  });
});

test("binary conflict keep-mine and keep-theirs preserve exact bytes", async () => {
  for (const side of ["mine", "theirs"] as const) {
    await withRemote({ "image.png": Uint8Array.from([0x89, 0x50, 0, 1]) }, async ({ remote, root }) => {
      const a = await makeDevice(remote.url, root, `binary-a-${side}`);
      const b = await makeDevice(remote.url, root, `binary-b-${side}`);
      await a.sync.clone(); await b.sync.clone();
      const theirs = Uint8Array.from([0x89, 0x50, 0, 2, 255]);
      const mine = Uint8Array.from([0, 255, 4, 3, 2, 1]);
      await a.writeBinary("image.png", theirs); await b.writeBinary("image.png", mine);
      assert.equal((await a.sync.sync(["image.png"])).success, true);
      const conflict = (await b.sync.sync(["image.png"])).conflictFiles[0];
      assert.equal(conflict.isBinary, true);
      const chosen = side === "mine" ? mine : theirs;
      const result = await b.sync.resolveConflict("image.png", { exists: true, content: chosen }, conflict.conflictSessionId);
      assert.equal(result.completed, true);
      assert.deepEqual(await b.readBinary("image.png"), Buffer.from(chosen));
    });
  }
});

test("fetch failures cannot report successful sync or pull", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "fetch-failure");
    await device.sync.clone();
    const internals = device.sync as never as {
      lastFetchError: string | null;
      safeFetch: () => Promise<string | null>;
    };
    internals.safeFetch = async () => {
      internals.lastFetchError = "fetch failed code=EACCES msg=denied";
      return null;
    };
    const result = await device.sync.sync([]);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /fetch failed/);
    await assert.rejects(device.sync.pull(), /fetch failed/);
  });
});

test("manual conflict staging failures block merge commit and push", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "stage-failure-a");
    const b = await makeDevice(remote.url, root, "stage-failure-b");
    await a.sync.clone(); await b.sync.clone();
    await a.adapter.remove("note.md"); await b.write("note.md", "local\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const conflict = (await b.sync.sync(["note.md"])).conflictFiles[0];
    const before = await git(["rev-parse", "main"], b.dir);
    const remoteBefore = await git(["--git-dir", remote.remotePath, "rev-parse", "main"]);
    const fs = (b.sync as never as { fs: { promises: { writeFile: (...args: unknown[]) => Promise<void> } } }).fs;
    const original = fs.promises.writeFile.bind(fs.promises);
    fs.promises.writeFile = async (...args: unknown[]) => {
      if (String(args[0]).endsWith("/.git/index")) throw Object.assign(new Error("index staging failed"), { code: "EIO" });
      return original(...args);
    };
    await assert.rejects(
      b.sync.resolveConflict("note.md", { exists: true, content: "local\n" }, conflict.conflictSessionId),
      /staging failed|multiple errors/i
    );
    assert.equal(await git(["rev-parse", "main"], b.dir), before);
    assert.equal(await git(["--git-dir", remote.remotePath, "rev-parse", "main"]), remoteBefore);
  });
});
