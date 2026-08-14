import test from "node:test";
import assert from "node:assert/strict";
import { classifySyncResult } from "../src/sync/result-classification";
import { ConflictFile, SyncResult } from "../src/types";

const conflict: ConflictFile = {
  path: "conflict-test.md", conflictSessionId: "session", ours: "LINUX VERSION",
  theirs: "MAC VERSION", oursExists: true, theirsExists: true, isBinary: false,
};

test("conflict payload takes precedence and never becomes a generic unknown error", () => {
  const result: SyncResult = { success: false, conflictFiles: [conflict], logs: ["sync() OK conflicts=1"] };
  assert.deepEqual(classifySyncResult(result), { kind: "conflict", conflicts: [conflict] });

  // Be defensive if a producer ever returns success alongside conflicts.
  assert.equal(classifySyncResult({ ...result, success: true }).kind, "conflict");
});

test("valid success and explicit failure remain distinct", () => {
  assert.deepEqual(classifySyncResult({ success: true, conflictFiles: [] }), { kind: "success" });
  assert.deepEqual(classifySyncResult({ success: false, conflictFiles: [], error: "offline" }),
    { kind: "error", message: "offline" });
});

test("malformed failure has an explicit diagnostic instead of unknown", () => {
  assert.deepEqual(classifySyncResult({ success: false, conflictFiles: [] }), {
    kind: "error", message: "Sync failed: no error details were returned.",
  });
  assert.deepEqual(classifySyncResult({ success: true } as SyncResult), {
    kind: "error", message: "Sync failed: invalid result did not include conflict details.",
  });
});
