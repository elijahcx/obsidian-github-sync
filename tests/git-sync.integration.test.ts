import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeDevice, withRemote, git } from "./helpers/harness";

test("sequential happy path syncs changes in both directions", async () => {
  await withRemote({ "base.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    assert.equal(await a.sync.clone(), true);
    assert.equal(await b.sync.clone(), true);

    await a.write("a.md", "from A\n");
    const aPush = await a.sync.sync(["a.md"]);
    assert.equal(aPush.success, true, aPush.error);

    const bPull = await b.sync.sync([]);
    assert.equal(bPull.success, true, bPull.error);
    assert.equal(await b.read("a.md"), "from A\n");

    await b.write("b.md", "from B\n");
    const bPush = await b.sync.sync(["b.md"]);
    assert.equal(bPush.success, true, bPush.error);

    const aPull = await a.sync.sync([]);
    assert.equal(aPull.success, true, aPull.error);
    assert.equal(await a.read("b.md"), "from B\n");
  });
});

test("pull refuses to overwrite dirty local work when the remote advanced", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const local = await makeDevice(remote.url, root, "dirty-pull-local");
    const other = await makeDevice(remote.url, root, "dirty-pull-other");
    await local.sync.clone();
    await other.sync.clone();

    await local.write("note.md", "unsynced local\n");
    await other.write("note.md", "remote update\n");
    assert.equal((await other.sync.sync(["note.md"])).success, true);

    await assert.rejects(local.sync.pull(), /Local working changes prevent pull: note\.md/);
    assert.equal(await local.read("note.md"), "unsynced local\n");
    assert.equal(await git(["--git-dir", remote.remotePath, "show", "main:note.md"]), "remote update");
  });
});

test("reproduces and recovers from non-fast-forward race after both devices fetch the same stale remote", async () => {
  await withRemote({ "base.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    assert.equal(await a.sync.clone(), true);
    assert.equal(await b.sync.clone(), true);

    const aInternals = a.sync as never as { safeFetch: () => Promise<string | null> };
    const bInternals = b.sync as never as { safeFetch: () => Promise<string | null> };
    const realAFetch = aInternals.safeFetch.bind(a.sync);
    const staleA = await realAFetch();
    const staleB = await bInternals.safeFetch();
    assert.ok(staleA);
    assert.equal(staleA, staleB);

    await a.write("a.md", "from A\n");
    await b.write("b.md", "from B\n");

    let aFetches = 0;
    aInternals.safeFetch = async () => {
      aFetches++;
      return aFetches === 1 ? staleA : realAFetch();
    };
    bInternals.safeFetch = async () => staleB;

    const bFirst = await b.sync.sync(["b.md"]);
    assert.equal(bFirst.success, true, bFirst.error);

    const aSecond = await a.sync.sync(["a.md"]);
    assert.equal(aSecond.success, true, aSecond.error);
    assert.equal(aSecond.conflictFiles.length, 0);
    assert.ok(aSecond.logs?.some((line) => line.includes("non-fast-forward")));
    assert.ok(aSecond.logs?.some((line) => line.includes("attempt=2")));
    assert.equal(await a.read("b.md"), "from B\n");

    const verifier = await makeDevice(remote.url, root, "verifier");
    assert.equal(await verifier.sync.clone(), true);
    assert.equal(await verifier.read("a.md"), "from A\n");
    assert.equal(await verifier.read("b.md"), "from B\n");
  });
});

test("successful push with no retry keeps the normal one-attempt path", async () => {
  await withRemote({ "base.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    assert.equal(await a.sync.clone(), true);

    await a.write("a.md", "from A\n");
    const result = await a.sync.sync(["a.md"]);
    assert.equal(result.success, true, result.error);
    assert.equal(result.logs?.filter((line) => line.includes("step3 pushing attempt=")).length, 1);
    assert.equal(result.logs?.some((line) => line.includes("non-fast-forward")), false);
  });
});

test("non-fast-forward followed by a merge conflict returns existing conflict payload", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    const aInternals = a.sync as never as { safeFetch: () => Promise<string | null> };
    const bInternals = b.sync as never as { safeFetch: () => Promise<string | null> };
    const realAFetch = aInternals.safeFetch.bind(a.sync);
    const stale = await realAFetch();
    assert.ok(stale);

    await a.write("note.md", "A edit\n");
    await b.write("note.md", "B edit\n");

    bInternals.safeFetch = async () => stale;
    assert.equal((await b.sync.sync(["note.md"])).success, true);

    let aFetches = 0;
    aInternals.safeFetch = async () => {
      aFetches++;
      return aFetches === 1 ? stale : realAFetch();
    };
    const result = await a.sync.sync(["note.md"]);
    assert.equal(result.success, false);
    assert.deepEqual(result.conflictFiles.map((c) => c.path), ["note.md"]);
    assert.equal(result.conflictFiles[0].ours, "A edit\n");
    assert.equal(result.conflictFiles[0].theirs, "B edit\n");
  });
});

test("Keep Theirs resolves cleanly and clears its session only after completion", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    await a.write("note.md", "A edit\n");
    await b.write("note.md", "B edit\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);

    const conflict = await b.sync.sync(["note.md"]);
    assert.equal(conflict.success, false);
    const [file] = conflict.conflictFiles;
    assert.ok(file.conflictSessionId);
    const internals = b.sync as never as { pendingMerge: unknown };
    assert.notEqual(internals.pendingMerge, null);

    const resolved = await b.sync.resolveConflict(file.path, file.theirs, file.conflictSessionId);
    assert.deepEqual(resolved, { completed: true, stale: false });
    assert.equal(await b.read("note.md"), "A edit\n");
    assert.equal(await git(["status", "--porcelain"], b.dir), "");
    assert.equal(internals.pendingMerge, null);

    const verifier = await makeDevice(remote.url, root, "verifier");
    assert.equal(await verifier.sync.clone(), true);
    assert.equal(await verifier.read("note.md"), "A edit\n");
  });
});

test("Keep Mine resolves cleanly, clears its session, and pushes without retry", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    await a.write("note.md", "A edit\n");
    await b.write("note.md", "B edit\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const conflict = (await b.sync.sync(["note.md"])).conflictFiles[0];

    const internals = b.sync as never as { safeFetch: () => Promise<string | null>; pendingMerge: unknown };
    assert.notEqual(internals.pendingMerge, null);
    const realFetch = internals.safeFetch.bind(b.sync);
    let retryFetches = 0;
    internals.safeFetch = async () => {
      retryFetches++;
      return realFetch();
    };

    const result = await b.sync.resolveConflict(conflict.path, conflict.ours, conflict.conflictSessionId);
    assert.deepEqual(result, { completed: true, stale: false });
    assert.equal(retryFetches, 0);
    assert.equal(await b.read("note.md"), "B edit\n");
    assert.equal(await git(["status", "--porcelain"], b.dir), "");
    assert.equal(internals.pendingMerge, null);

    const verifier = await makeDevice(remote.url, root, "verifier-mine");
    assert.equal(await verifier.sync.clone(), true);
    assert.equal(await verifier.read("note.md"), "B edit\n");
  });
});

test("conflict resolution refetches and cleanly merges when its push is rejected", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    await a.write("note.md", "A edit\n");
    await b.write("note.md", "B edit\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const conflict = (await b.sync.sync(["note.md"])).conflictFiles[0];

    await a.write("remote-after-modal.md", "remote advance\n");
    assert.equal((await a.sync.sync(["remote-after-modal.md"])).success, true);

    const result = await b.sync.resolveConflict(conflict.path, conflict.ours, conflict.conflictSessionId);
    assert.deepEqual(result, { completed: true, stale: false });
    assert.equal(await b.read("remote-after-modal.md"), "remote advance\n");

    const verifier = await makeDevice(remote.url, root, "verifier");
    assert.equal(await verifier.sync.clone(), true);
    assert.equal(await verifier.read("note.md"), "B edit\n");
    assert.equal(await verifier.read("remote-after-modal.md"), "remote advance\n");
  });
});

test("conflict resolution returns a fresh conflict session when retry merge conflicts", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    await a.write("note.md", "A first\n");
    await b.write("note.md", "B edit\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const oldConflict = (await b.sync.sync(["note.md"])).conflictFiles[0];

    await a.write("note.md", "A second\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);

    const result = await b.sync.resolveConflict(
      oldConflict.path,
      oldConflict.ours,
      oldConflict.conflictSessionId
    );
    assert.equal(result.completed, false);
    assert.equal(result.stale, false);
    assert.equal(result.conflictFiles?.length, 1);
    const newConflict = result.conflictFiles![0];
    assert.equal(newConflict.path, "note.md");
    assert.notEqual(newConflict.conflictSessionId, oldConflict.conflictSessionId);

    const oldAgain = await b.sync.resolveConflict(
      oldConflict.path,
      oldConflict.ours,
      oldConflict.conflictSessionId
    );
    assert.equal(oldAgain.stale, true);

    const resolved = await b.sync.resolveConflict(
      newConflict.path,
      newConflict.theirs,
      newConflict.conflictSessionId
    );
    assert.deepEqual(resolved, { completed: true, stale: false });
  });
});

test("conflict resolution push retries are bounded and never overwrite the remote", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    await a.write("note.md", "A edit\n");
    await b.write("note.md", "B edit\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const conflict = (await b.sync.sync(["note.md"])).conflictFiles[0];
    const stale = await (b.sync as never as { safeFetch: () => Promise<string | null> }).safeFetch();
    assert.ok(stale);

    await a.write("remote-wins.md", "preserved\n");
    assert.equal((await a.sync.sync(["remote-wins.md"])).success, true);

    let retryFetches = 0;
    (b.sync as never as { safeFetch: () => Promise<string | null> }).safeFetch = async () => {
      retryFetches++;
      return stale;
    };
    await assert.rejects(
      b.sync.resolveConflict(conflict.path, conflict.ours, conflict.conflictSessionId),
      /fast-forward|rejected/i
    );
    assert.equal(retryFetches, 2);

    const verifier = await makeDevice(remote.url, root, "verifier");
    assert.equal(await verifier.sync.clone(), true);
    assert.equal(await verifier.read("remote-wins.md"), "preserved\n");
    assert.equal(await verifier.read("note.md"), "A edit\n");
  });
});

test("resolving an old conflict session after a newer conflict replaces it is rejected", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    await a.write("note.md", "A1\n");
    await b.write("note.md", "B1\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const firstConflict = await b.sync.sync(["note.md"]);
    const first = firstConflict.conflictFiles[0];

    await a.write("note.md", "A2\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const secondConflict = await b.sync.sync([]);
    const second = secondConflict.conflictFiles[0];
    assert.notEqual(second.conflictSessionId, first.conflictSessionId);

    const oldResolution = await b.sync.resolveConflict(first.path, first.ours, first.conflictSessionId);
    assert.equal(oldResolution.stale, true);

    const newResolution = await b.sync.resolveConflict(second.path, second.theirs, second.conflictSessionId);
    assert.equal(newResolution.completed, true);
    assert.equal(newResolution.stale, false);
  });
});

test("abandoning an old conflict session does not clear a newer pending merge", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    await a.write("note.md", "A1\n");
    await b.write("note.md", "B1\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const first = (await b.sync.sync(["note.md"])).conflictFiles[0];

    await a.write("note.md", "A2\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const second = (await b.sync.sync([])).conflictFiles[0];
    assert.notEqual(second.conflictSessionId, first.conflictSessionId);

    await b.sync.abandonMerge(first.conflictSessionId);
    const resolution = await b.sync.resolveConflict(second.path, second.theirs, second.conflictSessionId);
    assert.equal(resolution.completed, true);
    assert.equal(resolution.stale, false);
  });
});

test("repository state advancing while a conflict modal is open invalidates the old session", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    await a.write("note.md", "A edit\n");
    await b.write("note.md", "B edit\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const file = (await b.sync.sync(["note.md"])).conflictFiles[0];

    await b.write("local.md", "local advance\n");
    await git(["add", "local.md"], b.dir);
    await git(["commit", "-m", "local advance"], b.dir);

    const resolution = await b.sync.resolveConflict(file.path, file.ours, file.conflictSessionId);
    assert.equal(resolution.stale, true);
    assert.match(resolution.message ?? "", /Repository state changed/);
  });
});

test("conflict resolution still works after a non-fast-forward retry produces a conflict", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    const aInternals = a.sync as never as { safeFetch: () => Promise<string | null> };
    const bInternals = b.sync as never as { safeFetch: () => Promise<string | null> };
    const realAFetch = aInternals.safeFetch.bind(a.sync);
    const stale = await realAFetch();
    assert.ok(stale);

    await a.write("note.md", "A edit\n");
    await b.write("note.md", "B edit\n");

    bInternals.safeFetch = async () => stale;
    assert.equal((await b.sync.sync(["note.md"])).success, true);

    let aFetches = 0;
    aInternals.safeFetch = async () => {
      aFetches++;
      return aFetches === 1 ? stale : realAFetch();
    };
    const conflict = await a.sync.sync(["note.md"]);
    assert.equal(conflict.success, false);
    const file = conflict.conflictFiles[0];

    const resolution = await a.sync.resolveConflict(file.path, file.ours, file.conflictSessionId);
    assert.equal(resolution.completed, true);
    assert.equal(resolution.stale, false);

    const verifier = await makeDevice(remote.url, root, "verifier");
    assert.equal(await verifier.sync.clone(), true);
    assert.equal(await verifier.read("note.md"), "A edit\n");
  });
});

test("retry limit is bounded when the remote keeps rejecting stale pushes", async () => {
  await withRemote({ "base.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    const stale = await (a.sync as never as { safeFetch: () => Promise<string | null> }).safeFetch();
    assert.ok(stale);
    (a.sync as never as { safeFetch: () => Promise<string | null> }).safeFetch = async () => stale;
    (b.sync as never as { safeFetch: () => Promise<string | null> }).safeFetch = async () => stale;

    await a.write("a.md", "from A\n");
    await b.write("b.md", "from B\n");
    assert.equal((await b.sync.sync(["b.md"])).success, true);

    const result = await a.sync.sync(["a.md"]);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /fast-forward|rejected/i);
    assert.equal(result.logs?.filter((line) => line.includes("step3 pushing attempt=")).length, 3);
  });
});

test("non-fast-forward recovery never force-pushes over remote changes", async () => {
  await withRemote({ "base.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    const stale = await (a.sync as never as { safeFetch: () => Promise<string | null> }).safeFetch();
    assert.ok(stale);
    (a.sync as never as { safeFetch: () => Promise<string | null> }).safeFetch = async () => stale;
    (b.sync as never as { safeFetch: () => Promise<string | null> }).safeFetch = async () => stale;

    await a.write("a.md", "from A\n");
    await b.write("b.md", "from B\n");
    assert.equal((await b.sync.sync(["b.md"])).success, true);

    const result = await a.sync.sync(["a.md"]);
    assert.equal(result.success, false);

    const verifier = await makeDevice(remote.url, root, "verifier");
    assert.equal(await verifier.sync.clone(), true);
    assert.equal(await verifier.read("b.md"), "from B\n");
    assert.equal(verifier.exists("a.md"), false);
  });
});

test("same-file concurrent edits return a conflict without mutating the file", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    await a.write("note.md", "A edit\n");
    await b.write("note.md", "B edit\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);

    const result = await b.sync.sync(["note.md"]);
    assert.equal(result.success, false);
    assert.deepEqual(result.conflictFiles.map((c) => c.path), ["note.md"]);
    assert.equal(result.conflictFiles[0].ours, "B edit\n");
    assert.equal(result.conflictFiles[0].theirs, "A edit\n");
    assert.equal(await b.read("note.md"), "B edit\n");
  });
});

test("delete/modify concurrent changes return a conflict", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    await a.adapter.remove("note.md");
    await b.write("note.md", "B edit\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);

    const result = await b.sync.sync(["note.md"]);
    assert.equal(result.success, false);
    assert.deepEqual(result.conflictFiles.map((c) => c.path), ["note.md"]);
    assert.equal(result.conflictFiles[0].ours, "B edit\n");
    assert.equal(result.conflictFiles[0].theirs, "");
  });
});

test("different-file divergent edits merge cleanly", async () => {
  await withRemote({ "base.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    await a.write("a.md", "A\n");
    await b.write("b.md", "B\n");
    assert.equal((await a.sync.sync(["a.md"])).success, true);

    const result = await b.sync.sync(["b.md"]);
    assert.equal(result.success, true, result.error);
    assert.equal(await b.read("a.md"), "A\n");
    assert.equal(await b.read("b.md"), "B\n");
  });
});

test("rename sync removes the old path and adds the new path without separate file events", async () => {
  await withRemote({ "old.md": "content\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    await a.sync.clone();

    await rename(path.join(a.dir, "old.md"), path.join(a.dir, "new.md"));
    const result = await a.sync.sync(["old.md", "new.md"]);
    assert.equal(result.success, true, result.error);

    const verifier = await makeDevice(remote.url, root, "verifier");
    assert.equal(await verifier.sync.clone(), true);
    assert.equal(verifier.exists("old.md"), false);
    assert.equal(await verifier.read("new.md"), "content\n");
  });
});

test("normal delete paths are removed from the remote", async () => {
  await withRemote({ "delete-me.md": "content\n", "keep.md": "keep\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    await a.sync.clone();

    await a.adapter.remove("delete-me.md");
    const result = await a.sync.sync(["delete-me.md"]);
    assert.equal(result.success, true, result.error);

    const verifier = await makeDevice(remote.url, root, "verifier");
    assert.equal(await verifier.sync.clone(), true);
    assert.equal(verifier.exists("delete-me.md"), false);
    assert.equal(await verifier.read("keep.md"), "keep\n");
  });
});

test(".obsidian files are excluded from commits and do not create spurious commits", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    await a.sync.clone();
    const before = await git(["--git-dir", path.join(a.dir, ".git"), "rev-parse", "main"]);

    await a.write(".obsidian/workspace.json", "local state\n");
    const result = await a.sync.sync([".obsidian/workspace.json"]);
    assert.equal(result.success, true, result.error);
    const after = await git(["--git-dir", path.join(a.dir, ".git"), "rev-parse", "main"]);
    assert.equal(after, before);
  });
});

test("excluded files do not cause bogus conflicts when remote and local excluded files differ", async () => {
  await withRemote({ "note.md": "base\n", ".obsidian/workspace.json": "remote\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    await mkdir(path.join(a.dir, ".obsidian"), { recursive: true });
    await writeFile(path.join(a.dir, ".obsidian/workspace.json"), "local\n", "utf8");
    await a.sync.clone();

    const result = await a.sync.sync([]);
    assert.equal(result.success, true, result.error);
    assert.equal(result.conflictFiles.length, 0);
    assert.equal(await readFile(path.join(a.dir, ".obsidian/workspace.json"), "utf8"), "local\n");
  });
});

test("remote tracked excluded changes advance history without overwriting the local file", async () => {
  await withRemote({ "note.md": "base\n", ".obsidian/workspace.json": "remote-v1\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();
    await b.write(".obsidian/workspace.json", "device-local\n");

    await a.write(".obsidian/workspace.json", "remote-v2\n");
    await git(["add", ".obsidian/workspace.json"], a.dir);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "remote excluded update"], a.dir);
    await git(["push", "origin", "main"], a.dir);
    const remoteHead = await git(["rev-parse", "HEAD"], a.dir);

    const result = await b.sync.sync([]);
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.conflictFiles, []);
    assert.equal(await b.read(".obsidian/workspace.json"), "device-local\n");
    assert.equal(await git(["rev-parse", "main"], b.dir), remoteHead);
  });
});

test("tracked .DS_Store advances with remote history while preserving the local metadata file", async () => {
  await withRemote({ ".DS_Store": "remote old\n", "note.md": "base\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "tracked-metadata-device");
    await device.write(".DS_Store", "local finder state\n");
    assert.equal(await device.sync.clone(), true);
    assert.equal(await device.read(".DS_Store"), "local finder state\n");

    const sourceDir = path.join(root, "tracked-metadata-source");
    await git(["clone", remote.url, sourceDir]);
    await git(["config", "user.name", "Test"], sourceDir);
    await git(["config", "user.email", "test@example.com"], sourceDir);
    await writeFile(path.join(sourceDir, ".DS_Store"), "remote new\n");
    await git(["add", ".DS_Store"], sourceDir);
    await git(["commit", "-m", "remote metadata update"], sourceDir);
    await git(["push", "origin", "main"], sourceDir);

    const result = await device.sync.syncAll(["note.md", ".DS_Store"]);
    assert.equal(result.success, true, result.error);
    assert.equal(await device.read(".DS_Store"), "local finder state\n");
    assert.deepEqual(result.changes, { added: 0, updated: 0, removed: 0 });
    assert.equal(await git(["show", "HEAD:.DS_Store"], device.dir), "remote new");
  });
});

test("divergent excluded tracked conflicts keep the remote tree and local working copy", async () => {
  await withRemote({ "note.md": "base\n", ".obsidian/workspace.json": "remote-v1\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    const b = await makeDevice(remote.url, root, "device-b");
    await a.sync.clone();
    await b.sync.clone();

    await b.write(".obsidian/workspace.json", "local-history\n");
    await git(["add", ".obsidian/workspace.json"], b.dir);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "local excluded history"], b.dir);
    await b.write(".obsidian/workspace.json", "device-local\n");

    await a.write(".obsidian/workspace.json", "remote-history\n");
    await git(["add", ".obsidian/workspace.json"], a.dir);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "remote excluded history"], a.dir);
    await git(["push", "origin", "main"], a.dir);
    const remoteHead = await git(["rev-parse", "HEAD"], a.dir);

    const result = await b.sync.sync([]);
    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.conflictFiles, []);
    assert.equal(await b.read(".obsidian/workspace.json"), "device-local\n");
    assert.equal(await git(["merge-base", "--is-ancestor", remoteHead, "main"], b.dir), "");
    assert.equal(
      await git(["show", "main:.obsidian/workspace.json"], b.dir),
      "remote-history"
    );

    const verifier = await makeDevice(remote.url, root, "verifier-excluded-merge");
    assert.equal(await verifier.sync.clone(), true);
    assert.equal(verifier.exists(".obsidian/workspace.json"), false);
    assert.equal(await git(["show", "main:.obsidian/workspace.json"], verifier.dir), "remote-history");
  });
});

test("excluded files are not checked out during clone", async () => {
  await withRemote({ "note.md": "remote note\n", ".obsidian/plugins/x/main.js": "remote plugin\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    assert.equal(await a.sync.clone(), true);
    assert.equal(await a.read("note.md"), "remote note\n");
    assert.equal(a.exists(".obsidian/plugins/x/main.js"), false);
  });
});

test("August 11 clone behavior preserves local excluded files while materializing non-excluded remote files", async () => {
  await withRemote({ "note.md": "remote note\n", ".obsidian/workspace.json": "remote workspace\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "device-a");
    await mkdir(path.join(a.dir, ".obsidian"), { recursive: true });
    await writeFile(path.join(a.dir, ".obsidian/workspace.json"), "local workspace\n", "utf8");

    assert.equal(await a.sync.clone(), true);
    assert.equal(await a.read("note.md"), "remote note\n");
    assert.equal(await a.read(".obsidian/workspace.json"), "local workspace\n");
  });
});

test("full sync discovers missed tracked deletions, including nested notes", async () => {
  await withRemote({ "note.md": "one\n", "nested/deep.md": "two\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "full-delete");
    await device.sync.clone();
    await device.adapter.remove("note.md");
    await device.adapter.remove("nested/deep.md");
    const result = await device.sync.syncAll([]);
    assert.equal(result.success, true, result.error);
    await assert.rejects(git(["--git-dir", remote.remotePath, "show", "main:note.md"]));
    await assert.rejects(git(["--git-dir", remote.remotePath, "show", "main:nested/deep.md"]));
  });
});

test("manual reconciliation reports structured Git tree changes", async () => {
  await withRemote({ "updated.md": "old\n", "removed.md": "remove\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "summary-counts");
    await device.sync.clone();

    const unchanged = await device.sync.syncAll(["updated.md", "removed.md"]);
    assert.deepEqual(unchanged.changes, { added: 0, updated: 0, removed: 0 });

    await device.write("added.md", "new\n");
    await device.write("updated.md", "changed\n");
    await device.adapter.remove("removed.md");
    const changed = await device.sync.syncAll(["added.md", "updated.md"]);
    assert.equal(changed.success, true, changed.error);
    assert.deepEqual(changed.changes, { added: 1, updated: 1, removed: 1 });
  });
});

test("full sync never treats excluded absence or provider stat failure as deletion", async () => {
  await withRemote({ "note.md": "keep\n", ".obsidian/workspace.json": "history\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "safe-full-delete");
    await device.sync.clone();
    const originalStat = device.adapter.stat.bind(device.adapter);
    device.adapter.stat = async (filepath) => {
      if (filepath === "note.md") throw Object.assign(new Error("provider unavailable"), { code: "EIO" });
      return originalStat(filepath);
    };
    const result = await device.sync.syncAll([]);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /provider unavailable/);
    assert.equal(await git(["--git-dir", remote.remotePath, "show", "main:note.md"]), "keep");
    assert.equal(await git(["--git-dir", remote.remotePath, "show", "main:.obsidian/workspace.json"]), "history");
  });
});

test("folder rename and deletion reconcile tracked descendants idempotently", async () => {
  await withRemote({ "old/a.md": "a\n", "old/nested/b.md": "b\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "folder-events");
    await device.sync.clone();
    await rename(path.join(device.dir, "old"), path.join(device.dir, "new"));
    const renamed = await device.sync.sync(["old", "new/a.md", "new/nested/b.md", "old/a.md"]);
    assert.equal(renamed.success, true, renamed.error);
    assert.equal(await git(["--git-dir", remote.remotePath, "show", "main:new/a.md"]), "a");
    assert.equal(await git(["--git-dir", remote.remotePath, "show", "main:new/nested/b.md"]), "b");
    await assert.rejects(git(["--git-dir", remote.remotePath, "show", "main:old/a.md"]));

    await rm(path.join(device.dir, "new"), { recursive: true });
    const deleted = await device.sync.sync(["new", "new/a.md"]);
    assert.equal(deleted.success, true, deleted.error);
    assert.equal(await git(["--git-dir", remote.remotePath, "ls-tree", "-r", "--name-only", "main"]), "");
  });
});

test("folder expansion preserves excluded descendants and avoids prefix collisions", async () => {
  await withRemote({
    "folder/a.md": "remove\n",
    "folder/private/keep.md": "historical excluded\n",
    "folder-old/keep.md": "prefix neighbor\n",
  }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "folder-exclusions");
    const internals = device.sync as unknown as { isExcluded: (path: string) => boolean };
    internals.isExcluded = (path) => path.startsWith("folder/private/") || path.startsWith(".obsidian/");
    await device.sync.clone();
    await rm(path.join(device.dir, "folder"), { recursive: true });
    const result = await device.sync.sync(["folder"]);
    assert.equal(result.success, true, result.error);
    await assert.rejects(git(["--git-dir", remote.remotePath, "show", "main:folder/a.md"]));
    assert.equal(
      await git(["--git-dir", remote.remotePath, "show", "main:folder/private/keep.md"]),
      "historical excluded"
    );
    assert.equal(
      await git(["--git-dir", remote.remotePath, "show", "main:folder-old/keep.md"]),
      "prefix neighbor"
    );
  });
});

test("syncAll preserves zero-byte and binary files", async () => {
  await withRemote({ "base.md": "base\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "full-binary");
    await device.sync.clone();
    await device.write("empty.md", "");
    const binary = Buffer.from([0, 255, 1, 2, 0, 42]);
    await device.writeBinary("assets/data.bin", binary);
    const result = await device.sync.syncAll(["empty.md", "assets/data.bin", "base.md"]);
    assert.equal(result.success, true, result.error);
    assert.equal(await git(["--git-dir", remote.remotePath, "show", "main:empty.md"]), "");
    const verifier = await makeDevice(remote.url, root, "full-binary-verifier");
    await verifier.sync.clone();
    assert.deepEqual(await verifier.readBinary("assets/data.bin"), binary);
  });
});

test("failed conflict completion does not misleadingly leave an applicable old session", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "resolution-failure-a");
    const b = await makeDevice(remote.url, root, "resolution-failure-b");
    await a.sync.clone(); await b.sync.clone();
    await a.write("note.md", "A\n"); await b.write("note.md", "B\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const conflict = (await b.sync.sync(["note.md"])).conflictFiles[0];
    const internals = b.sync as unknown as {
      pushWithRetry: () => Promise<never>;
    };
    internals.pushWithRetry = async () => { throw new Error("push provider failed"); };
    await assert.rejects(
      b.sync.resolveConflict(conflict.path, conflict.ours, conflict.conflictSessionId),
      /run Sync Now to refresh conflicts/
    );
    const stale = await b.sync.resolveConflict(conflict.path, conflict.ours, conflict.conflictSessionId);
    assert.equal(stale.stale, true);
  });
});
