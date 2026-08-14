import test from "node:test";
import assert from "node:assert/strict";
import { DataAdapter, FileSystemAdapter } from "obsidian";
import {
  activateAfterStartupReconciliation,
  vaultPathForAdapter,
} from "../src/startup-lifecycle";

test("vault event reactions activate only after startup reconciliation settles", async () => {
  let finishReconciliation!: () => void;
  const reconciliation = new Promise<void>((resolve) => {
    finishReconciliation = resolve;
  });
  let active = false;
  const queued: string[] = [];
  const emitVaultEvent = (path: string) => {
    if (active) queued.push(path);
  };

  const startup = activateAfterStartupReconciliation(
    () => reconciliation,
    () => { active = true; }
  );

  emitVaultEvent("initial-vault-population.md");
  emitVaultEvent("materialized-by-startup-pull.md");
  assert.deepEqual(queued, []);

  finishReconciliation();
  await startup;
  emitVaultEvent("user-edit.md");
  assert.deepEqual(queued, ["user-edit.md"]);
});

test("vault event reactions still activate after an offline startup pull", async () => {
  let activations = 0;
  await assert.rejects(
    activateAfterStartupReconciliation(
      async () => { throw new Error("offline"); },
      () => { activations++; }
    ),
    /offline/
  );
  assert.equal(activations, 1);
});

test("desktop uses FileSystemAdapter root while mobile stays adapter-relative", () => {
  const desktop = new FileSystemAdapter();
  desktop.getBasePath = () => "/vault";
  const mobile = {} as DataAdapter;

  assert.equal(vaultPathForAdapter(desktop), "/vault");
  assert.equal(vaultPathForAdapter(mobile), "");
});
