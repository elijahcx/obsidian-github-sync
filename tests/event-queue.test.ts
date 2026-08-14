import test from "node:test";
import assert from "node:assert/strict";
import { SYNC_DEBOUNCE_MS } from "../src/constants";
import { enqueueDelete, enqueueFolderDelete, enqueueFolderRename, enqueueRename } from "../src/sync/events";
import { SyncQueue } from "../src/sync/queue";
import type { GitSync } from "../src/sync/git-sync";
import { normalizeGitPath, normalizeVaultPath } from "../src/sync/paths";
import { createFsAdapter } from "../src/sync/fs-adapter";
import { LocalAdapter } from "./helpers/harness";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const excluded = (path: string) => path === ".obsidian" || path.startsWith(".obsidian/");

function recordingQueue(): { paths: string[]; enqueue: (path: string) => void } {
  const paths: string[] = [];
  return { paths, enqueue: (path) => paths.push(path) };
}

test("rename queues the old path removal and new path addition without other events", () => {
  const queue = recordingQueue();
  enqueueRename(queue, "old.md", "folder/new.md", excluded);
  assert.deepEqual(queue.paths, ["old.md", "folder/new.md"]);
});

test("Git paths and Windows vault roots are normalized centrally", () => {
  assert.equal(normalizeGitPath("folder\\nested\\note.with.dots.md"), "folder/nested/note.with.dots.md");
  assert.equal(normalizeGitPath("./folder//name with spaces.md"), "folder/name with spaces.md");
  assert.equal(normalizeVaultPath("C:\\Users\\Test\\Vault\\"), "C:/Users/Test/Vault");
  assert.equal(normalizeVaultPath(""), "");
});

test("Windows-style absolute Git paths become relative only at the DataAdapter boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "windows-adapter-"));
  try {
    const fs = createFsAdapter(new LocalAdapter(root) as never, "C:\\Users\\Test\\Vault");
    await fs.promises.writeFile("C:\\Users\\Test\\Vault\\nested\\name with spaces.md", "content\n");
    assert.equal(await readFile(path.join(root, "nested/name with spaces.md"), "utf8"), "content\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fs adapter propagates provider unlink, readdir, and mkdir failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adapter-errors-"));
  try {
    const adapter = new LocalAdapter(root);
    const fs = createFsAdapter(adapter as never, root);
    await fs.promises.unlink(path.join(root, "missing.md")); // proven ENOENT is harmless

    await adapter.write("present.md", "keep");
    adapter.remove = async () => { throw Object.assign(new Error("remove denied"), { code: "EACCES" }); };
    await assert.rejects(fs.promises.unlink(path.join(root, "present.md")), /remove denied/);

    adapter.list = async () => { throw Object.assign(new Error("provider offline"), { code: "EIO" }); };
    await assert.rejects(fs.promises.readdir(root), /provider offline/);

    adapter.mkdir = async () => { throw Object.assign(new Error("mkdir denied"), { code: "EACCES" }); };
    await assert.rejects(fs.promises.mkdir(path.join(root, "new-folder")), /mkdir denied/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows-style rename and delete events enqueue POSIX Git paths", () => {
  const queue = recordingQueue();
  enqueueRename(queue, "folder\\old name.md", "folder\\new.name.md", excluded);
  enqueueDelete(queue, "deep\\nested\\CON.md", excluded);
  assert.deepEqual(queue.paths, ["folder/old name.md", "folder/new.name.md", "deep/nested/CON.md"]);
});

test("Windows-style excluded event paths remain excluded", () => {
  const queue = recordingQueue();
  enqueueRename(queue, ".obsidian\\old.json", ".obsidian\\new.json", excluded);
  enqueueDelete(queue, ".obsidian\\workspace.json", excluded);
  assert.deepEqual(queue.paths, []);
});

test("rename exclusions are applied independently to both paths", () => {
  const intoExcluded = recordingQueue();
  enqueueRename(intoExcluded, "note.md", ".obsidian/note.md", excluded);
  assert.deepEqual(intoExcluded.paths, ["note.md"]);

  const outOfExcluded = recordingQueue();
  enqueueRename(outOfExcluded, ".obsidian/note.md", "note.md", excluded);
  assert.deepEqual(outOfExcluded.paths, ["note.md"]);

  const whollyExcluded = recordingQueue();
  enqueueRename(whollyExcluded, ".obsidian/old.json", ".obsidian/new.json", excluded);
  assert.deepEqual(whollyExcluded.paths, []);
});

test("excluded deletes do not queue sync work while normal deletes do", () => {
  const queue = recordingQueue();
  enqueueDelete(queue, ".obsidian/workspace.json", excluded);
  enqueueDelete(queue, "note.md", excluded);
  assert.deepEqual(queue.paths, ["note.md"]);
});

test("folder rename and delete enqueue recursive, normalized, exclusion-safe work", () => {
  const queue = recordingQueue();
  enqueueFolderRename(queue, "old", "new", ["new/a.md", "new/nested/b.md"], excluded);
  enqueueFolderDelete(queue, "deleted", excluded);
  assert.deepEqual(queue.paths, [
    "old", "new", "old/a.md", "new/a.md", "old/nested/b.md", "new/nested/b.md", "deleted",
  ]);

  const movedIntoExcluded = recordingQueue();
  enqueueFolderRename(movedIntoExcluded, "notes", ".obsidian/notes", [".obsidian/notes/a.md"], excluded);
  assert.deepEqual(movedIntoExcluded.paths, ["notes", "notes/a.md"]);

  const movedOutOfExcluded = recordingQueue();
  enqueueFolderRename(movedOutOfExcluded, ".obsidian/notes", "notes", ["notes/a.md"], excluded);
  assert.deepEqual(movedOutOfExcluded.paths, ["notes", "notes/a.md"]);
});

function queueWithSync(debounceMs?: number): { queue: SyncQueue; calls: string[][] } {
  const calls: string[][] = [];
  const sync = {
    sync: async (files: string[]) => {
      calls.push(files);
      return { success: true, conflictFiles: [] };
    },
  } as unknown as GitSync;
  return {
    queue: new SyncQueue(sync, () => {}, debounceMs),
    calls,
  };
}

test("SyncQueue preserves the default debounce value", () => {
  const { queue } = queueWithSync();
  assert.equal(queue.getDebounceMs(), SYNC_DEBOUNCE_MS);
});

test("SyncQueue exposes an immutable filename-free diagnostic snapshot", async () => {
  let release!: () => void;
  const sync = { sync: async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { success: true, conflictFiles: [] };
  } } as unknown as GitSync;
  const queue = new SyncQueue(sync, () => {}, 10_000);
  queue.enqueue("private-note.md");
  assert.deepEqual(queue.getDiagnostics(), {
    pendingCount: 1, active: false, debouncePending: true,
    conflictPaused: false, shuttingDown: false,
  });
  const flush = queue.flushNow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(queue.getDiagnostics().active, true);
  assert.equal("pendingFiles" in queue.getDiagnostics(), false);
  release();
  await flush;
  queue.pauseForConflict();
  assert.equal(queue.getDiagnostics().conflictPaused, true);
  const shutdown = queue.shutdown();
  assert.equal(queue.getDiagnostics().shuttingDown, true);
  await shutdown;
});

test("SyncQueue uses a custom debounce value", async () => {
  const { queue, calls } = queueWithSync(10);
  queue.enqueue("note.md");
  assert.equal(queue.getDebounceMs(), 10);
  assert.equal(calls.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls, [["note.md"]]);
});

test("changing debounce while work is pending safely reschedules the flush", async () => {
  const { queue, calls } = queueWithSync(100);
  queue.enqueue("note.md");
  queue.setDebounceMs(10);
  assert.equal(queue.getDebounceMs(), 10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls, [["note.md"]]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls.length, 1);
});

test("failed SyncQueue batches remain pending and succeed on a later retry", async () => {
  let attempts = 0;
  const calls: string[][] = [];
  const sync = { sync: async (files: string[]) => {
    calls.push(files);
    attempts++;
    return attempts === 1
      ? { success: false, conflictFiles: [], error: "offline" }
      : { success: true, conflictFiles: [] };
  } } as unknown as GitSync;
  const queue = new SyncQueue(sync, () => {}, 1000);
  queue.enqueue("a.md");
  const failed = await queue.flushNow();
  assert.equal(failed?.success, false);
  assert.deepEqual(queue.getPendingFiles(), ["a.md"]);
  const recovered = await queue.flushNow();
  assert.equal(recovered?.success, true);
  assert.deepEqual(calls, [["a.md"], ["a.md"]]);
  assert.deepEqual(queue.getPendingFiles(), []);
});

test("events arriving during a failed batch remain queued without concurrent flushes", async () => {
  let release!: (result: { success: boolean; conflictFiles: never[]; error?: string }) => void;
  let active = 0;
  let maxActive = 0;
  const calls: string[][] = [];
  const sync = { sync: async (files: string[]) => {
    calls.push(files);
    active++;
    maxActive = Math.max(maxActive, active);
    const result = await new Promise<{ success: boolean; conflictFiles: never[]; error?: string }>((resolve) => { release = resolve; });
    active--;
    return result;
  } } as unknown as GitSync;
  const queue = new SyncQueue(sync, () => {}, 1000);
  queue.enqueue("a.md");
  const first = queue.flushNow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  queue.enqueue("b.md");
  const overlapping = queue.flushNow();
  release({ success: false, conflictFiles: [], error: "temporary" });
  await Promise.all([first, overlapping]);
  assert.equal(maxActive, 1);
  assert.deepEqual(new Set(queue.getPendingFiles()), new Set(["a.md", "b.md"]));
  assert.deepEqual(calls, [["a.md"]]);
});

test("shutdown drains pending debounce and waits for an active flush without overlap", async () => {
  let release!: () => void;
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const sync = { sync: async () => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
    active--;
    return { success: true, conflictFiles: [] };
  } } as unknown as GitSync;
  const idleQueue = new SyncQueue(sync, () => {}, 1000);
  assert.equal(await idleQueue.shutdown(), null);
  const queue = new SyncQueue(sync, () => {}, 1000);
  queue.enqueue("a.md");
  const activeFlush = queue.flushNow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  queue.enqueue("b.md");
  const shutdown = queue.shutdown();
  release();
  await Promise.all([activeFlush, shutdown]);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(queue.getPendingFiles(), []);
});

test("a failed unload flush keeps its batch discoverable", async () => {
  const sync = { sync: async () => ({ success: false, conflictFiles: [], error: "offline" }) } as unknown as GitSync;
  const queue = new SyncQueue(sync, () => {}, 1000);
  queue.enqueue("offline.md");
  const result = await queue.shutdown();
  assert.equal(result?.success, false);
  assert.deepEqual(queue.getPendingFiles(), ["offline.md"]);
});

test("queue pauses after conflict, collects events, and resumes exactly once", async () => {
  const calls: string[][] = [];
  const sync = { sync: async (files: string[]) => {
    calls.push(files);
    return calls.length === 1
      ? { success: false, conflictFiles: [{ path: "conflict.md" }] }
      : { success: true, conflictFiles: [] };
  } } as unknown as GitSync;
  const queue = new SyncQueue(sync, () => {}, 5);
  queue.enqueue("conflict.md");
  await queue.flushNow();
  queue.enqueue("one.md");
  queue.enqueue("two.md");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  queue.resumeAfterConflict();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [["conflict.md"], ["one.md", "two.md"]]);
});

test("shutdown fences enqueue, callbacks, repeated shutdown, and post-timeout drain", async () => {
  let release!: () => void;
  let calls = 0;
  let statuses = 0;
  const sync = { sync: async () => {
    calls++;
    await new Promise<void>((resolve) => { release = resolve; });
    return { success: true, conflictFiles: [] };
  } } as unknown as GitSync;
  const queue = new SyncQueue(sync, () => { statuses++; }, 5);
  queue.enqueue("active.md");
  const active = queue.flushNow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const shutdownA = queue.shutdown(5);
  const shutdownB = queue.shutdown(5);
  queue.enqueue("after-shutdown.md");
  const [a, b] = await Promise.all([shutdownA, shutdownB]);
  assert.equal(a?.success, false);
  assert.equal(b?.success, false);
  assert.equal(calls, 1);
  release();
  await active;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  assert.equal(statuses, 1); // pushing happened before shutdown; completion callback was fenced
  assert.deepEqual(queue.getPendingFiles(), ["after-shutdown.md"]);
});
