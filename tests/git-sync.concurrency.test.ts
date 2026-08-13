import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitSync } from "../src/sync/git-sync";
import { SyncQueue } from "../src/sync/queue";
import type { ConflictFile, ConflictResolutionResult, SyncResult } from "../src/types";
import { LocalAdapter } from "./helpers/harness";

type Internals = {
  syncUnlocked: (files: string[]) => Promise<SyncResult>;
  pullUnlocked: () => Promise<ConflictFile[]>;
  resolveConflictUnlocked: (filepath: string, content: string, conflictSessionId: string) => Promise<ConflictResolutionResult>;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  // Public operations now perform an asynchronous recovery-journal check before
  // entering their mocked core operation. Wait until those filesystem promises
  // have had a deterministic opportunity to settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

async function withSyncs(
  fn: (first: GitSync, second: GitSync) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "git-sync-lock-"));
  const adapter = new LocalAdapter(dir);
  const make = () => new GitSync(adapter as never, dir, "token", "user", "repo");
  try {
    await fn(make(), make());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("simultaneous sync requests on the same vault execute serially", async () => {
  await withSyncs(async (first, second) => {
    const gate = deferred();
    const starts: string[] = [];
    (first as unknown as Internals).syncUnlocked = async () => {
      starts.push("first");
      await gate.promise;
      return { success: true, conflictFiles: [] };
    };
    (second as unknown as Internals).syncUnlocked = async () => {
      starts.push("second");
      return { success: true, conflictFiles: [] };
    };

    const one = first.sync([]);
    const two = second.sync([]);
    await nextTurn();
    assert.deepEqual(starts, ["first"]);

    gate.resolve();
    await Promise.all([one, two]);
    assert.deepEqual(starts, ["first", "second"]);
  });
});

test("manual sync waits for an auto-sync queue flush", async () => {
  await withSyncs(async (sync) => {
    const gate = deferred();
    const starts: string[] = [];
    let call = 0;
    (sync as unknown as Internals).syncUnlocked = async () => {
      starts.push(call++ === 0 ? "auto" : "manual");
      if (call === 1) await gate.promise;
      return { success: true, conflictFiles: [] };
    };

    const queue = new SyncQueue(sync, () => {});
    queue.enqueue("auto.md");
    const auto = queue.flushNow();
    await nextTurn();
    const manual = sync.sync(["manual.md"]);
    await nextTurn();
    assert.deepEqual(starts, ["auto"]);

    gate.resolve();
    await Promise.all([auto, manual]);
    assert.deepEqual(starts, ["auto", "manual"]);
  });
});

test("pull waits for an active sync", async () => {
  await withSyncs(async (sync) => {
    const gate = deferred();
    const starts: string[] = [];
    (sync as unknown as Internals).syncUnlocked = async () => {
      starts.push("sync");
      await gate.promise;
      return { success: true, conflictFiles: [] };
    };
    (sync as unknown as Internals).pullUnlocked = async () => {
      starts.push("pull");
      return [];
    };

    const syncing = sync.sync([]);
    const pulling = sync.pull();
    await nextTurn();
    assert.deepEqual(starts, ["sync"]);
    gate.resolve();
    await Promise.all([syncing, pulling]);
    assert.deepEqual(starts, ["sync", "pull"]);
  });
});

test("a failing operation releases the vault lock", async () => {
  await withSyncs(async (first, second) => {
    (first as unknown as Internals).pullUnlocked = async () => {
      throw new Error("expected failure");
    };
    (second as unknown as Internals).syncUnlocked = async () => ({
      success: true,
      conflictFiles: [],
    });

    await assert.rejects(first.pull(), /expected failure/);
    assert.equal((await second.sync([])).success, true);
  });
});

test("conflict resolution waits for an active sync", async () => {
  await withSyncs(async (sync) => {
    const gate = deferred();
    const starts: string[] = [];
    (sync as unknown as Internals).syncUnlocked = async () => {
      starts.push("sync");
      await gate.promise;
      return { success: true, conflictFiles: [] };
    };
    (sync as unknown as Internals).resolveConflictUnlocked = async () => {
      starts.push("resolve");
      return { completed: true, stale: false };
    };

    const syncing = sync.sync([]);
    const resolving = sync.resolveConflict("note.md", "resolved\n", "session");
    await nextTurn();
    assert.deepEqual(starts, ["sync"]);
    gate.resolve();
    await Promise.all([syncing, resolving]);
    assert.deepEqual(starts, ["sync", "resolve"]);
  });
});
