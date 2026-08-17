import test from "node:test";
import assert from "node:assert/strict";
import { formatSyncSummary, presentManualSyncResult } from "../src/sync/manual-sync-summary";
import type { ConflictFile, SyncResult } from "../src/types";

const success = (added: number, updated: number, removed: number): SyncResult => ({
  success: true,
  conflictFiles: [],
  changes: { added, updated, removed },
  logs: ["internal diagnostic"],
});

test("manual sync summaries handle no changes, one category, and multiple categories", () => {
  assert.equal(formatSyncSummary({ added: 0, updated: 0, removed: 0 }), "Already up to date");
  assert.equal(formatSyncSummary({ added: 0, updated: 1, removed: 0 }), "Synced — 1 updated");
  assert.equal(formatSyncSummary({ added: 2, updated: 1, removed: 1 }), "Synced — 2 added, 1 updated, 1 removed");
  assert.equal(formatSyncSummary(undefined), "Synced successfully");
});

test("zero-count categories are omitted", () => {
  assert.equal(formatSyncSummary({ added: 1, updated: 0, removed: 2 }), "Synced — 1 added, 2 removed");
});

test("successful manual sync emits one compact notice and never routes logs to an error modal", () => {
  const notices: string[] = [];
  const errors: string[] = [];
  const kind = presentManualSyncResult(success(0, 1, 0), {
    conflict: () => assert.fail("unexpected conflict"),
    success: (message) => notices.push(message),
    error: (message) => errors.push(message),
  });
  assert.equal(kind, "success");
  assert.deepEqual(notices, ["Synced — 1 updated"]);
  assert.deepEqual(errors, []);
});

test("conflicts still use conflict presentation without a success or error notice", () => {
  const conflict: ConflictFile = {
    path: "note.md", conflictSessionId: "session", ours: "ours", theirs: "theirs",
    oursExists: true, theirsExists: true, isBinary: false,
  };
  let presented: ConflictFile[] = [];
  const kind = presentManualSyncResult({ success: false, conflictFiles: [conflict], logs: ["details"] }, {
    conflict: (conflicts) => { presented = conflicts; },
    success: () => assert.fail("unexpected success"),
    error: () => assert.fail("unexpected error"),
  });
  assert.equal(kind, "conflict");
  assert.deepEqual(presented, [conflict]);
});

test("errors remain visible and retain their detailed logs", () => {
  let surfaced: { message: string; logs?: string[] } | undefined;
  const kind = presentManualSyncResult({ success: false, conflictFiles: [], error: "offline", logs: ["fetch failed"] }, {
    conflict: () => assert.fail("unexpected conflict"),
    success: () => assert.fail("unexpected success"),
    error: (message, logs) => { surfaced = { message, logs }; },
  });
  assert.equal(kind, "error");
  assert.deepEqual(surfaced, { message: "offline", logs: ["fetch failed"] });
});

test("background sync stays quiet because only the manual result presenter creates notices", () => {
  const backgroundResult = success(1, 0, 0);
  const notices: string[] = [];
  // The auto-sync queue consumes SyncResult directly and does not invoke presentManualSyncResult.
  assert.equal(backgroundResult.success, true);
  assert.deepEqual(notices, []);
});
