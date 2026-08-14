import test from "node:test";
import assert from "node:assert/strict";
import { ConflictModal, ResolveOutcome } from "../src/ui/conflict-modal";
import type { ConflictChoice, ConflictFile } from "../src/types";
import { persistResolutionMetadata } from "../src/sync/resolution-completion";

type ModalInternals = {
  resolving: boolean;
  completed: boolean;
  currentIndex: number;
  conflicts: ConflictFile[];
  onResolve: () => Promise<ResolveOutcome>;
  contentEl: { querySelectorAll: () => Array<{ disabled: boolean }>; createEl: () => void };
  renderCurrent: () => void;
  close: () => void;
  resolve: (conflict: ConflictFile, choice: ConflictChoice) => Promise<void>;
};

const conflict: ConflictFile = {
  path: "note.md", conflictSessionId: "session", ours: "ours", theirs: "theirs",
  oursExists: true, theirsExists: true, isBinary: false,
};

function fakeModal(onResolve: () => Promise<ResolveOutcome>) {
  let closes = 0;
  let renders = 0;
  const button = { disabled: false };
  const modal = Object.create(ConflictModal.prototype) as ModalInternals;
  Object.assign(modal, {
    resolving: false, completed: false, currentIndex: 0, conflicts: [conflict], onResolve,
    contentEl: { querySelectorAll: () => [button], createEl: () => {} },
    renderCurrent: () => { renders++; }, close: () => { closes++; },
  });
  return { modal, button, closes: () => closes, renders: () => renders };
}

test("conflict modal waits for async success and prevents double submission", async () => {
  let release!: (outcome: ResolveOutcome) => void;
  let calls = 0;
  const { modal, button, closes } = fakeModal(async () => {
    calls++;
    return new Promise<ResolveOutcome>((resolve) => { release = resolve; });
  });
  const choice = { exists: true, content: "ours" };
  const first = modal.resolve(conflict, choice);
  const second = modal.resolve(conflict, choice);
  assert.equal(button.disabled, true);
  assert.equal(closes(), 0);
  assert.equal(calls, 1);
  release("accepted");
  await Promise.all([first, second]);
  assert.equal(closes(), 1);
  assert.equal(modal.completed, true);
});

test("failed or stale conflict resolution keeps the modal open", async () => {
  const rejected = fakeModal(async () => "rejected");
  await rejected.modal.resolve(conflict, { exists: true, content: "ours" });
  assert.equal(rejected.closes(), 0);
  assert.equal(rejected.modal.currentIndex, 0);
  assert.equal(rejected.renders(), 1);

  const failed = fakeModal(async () => { throw new Error("provider failed"); });
  await failed.modal.resolve(conflict, { exists: true, content: "ours" });
  assert.equal(failed.closes(), 0);
  assert.equal(failed.modal.currentIndex, 0);
  assert.equal(failed.renders(), 1);
});

test("a replacement conflict session closes the old modal without abandonment", async () => {
  const replacement = fakeModal(async () => "replaced");
  await replacement.modal.resolve(conflict, { exists: true, content: "ours" });
  assert.equal(replacement.closes(), 1);
  assert.equal(replacement.modal.completed, true);
});

test("settings persistence failure does not turn confirmed Git resolution into failure", async () => {
  let reported = "";
  await assert.doesNotReject(persistResolutionMetadata(
    async () => { throw new Error("settings unavailable"); },
    (error) => { reported = error instanceof Error ? error.message : String(error); }
  ));
  assert.equal(reported, "settings unavailable");

  const modal = fakeModal(async () => {
    await persistResolutionMetadata(
      async () => { throw new Error("settings unavailable"); },
      () => {}
    );
    return "accepted";
  });
  await modal.modal.resolve(conflict, { exists: true, content: "ours" });
  assert.equal(modal.closes(), 1);
  assert.equal(modal.modal.completed, true);
});
