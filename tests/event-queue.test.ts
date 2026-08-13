import test from "node:test";
import assert from "node:assert/strict";
import { SYNC_DEBOUNCE_MS } from "../src/constants";
import { enqueueDelete, enqueueRename } from "../src/sync/events";
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
