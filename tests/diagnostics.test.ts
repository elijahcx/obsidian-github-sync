import test from "node:test";
import assert from "node:assert/strict";
import { buildDiagnosticReport, buildStatusTooltip, SyncDiagnostics } from "../src/diagnostics";
import { SyncStatus } from "../src/types";
import { statusLabel } from "../src/ui/status-bar";

function diagnostics(status: SyncStatus = "idle"): SyncDiagnostics {
  return {
    version: "1.0.15", status, connected: true,
    githubUsername: "octocat", repoName: "notes", autoSync: true,
    debounceMs: 3000, remoteIntervalMs: 15_000, lastSuccessfulSyncAt: 9_000,
    queue: { pendingCount: 0, active: false, debouncePending: false, conflictPaused: false, shuttingDown: false },
    polling: { enabled: true, running: true, inFlight: false, lastAttemptAt: 9_500, lastSuccessAt: 9_500, lastOutcome: "success" },
  };
}

test("safe report contains configured state but no credentials or vault path", () => {
  const report = buildDiagnosticReport(diagnostics());
  assert.match(report, /Git Sync Vault Diagnostics/);
  assert.match(report, /Version: 1\.0\.15/);
  assert.match(report, /GitHub username: octocat/);
  assert.match(report, /Last remote outcome: check-completed/);
  assert.doesNotMatch(report, /Last remote outcome: success/);
  assert.match(report, /Pending files: 0/);
  assert.doesNotMatch(report, /token|Authorization|Client Secret|\/Users\/secret/i);
});

test("status tooltip is deterministic, compact, and safe for every status", () => {
  for (const status of ["idle", "pulling", "pushing", "conflict", "error", "connecting"] as SyncStatus[]) {
    const tooltip = buildStatusTooltip(diagnostics(status), 10_000);
    assert.match(tooltip, /Git Sync Vault\nStatus:/);
    assert.match(tooltip, /Last sync: 1s ago/);
    assert.match(tooltip, /Pending files: 0/);
    assert.doesNotMatch(tooltip, /token|Authorization/i);
  }
});

test("status bar labels remain compact for every SyncStatus", () => {
  assert.deepEqual({
    idle: statusLabel("idle"), pulling: statusLabel("pulling"), pushing: statusLabel("pushing"),
    conflict: statusLabel("conflict"), error: statusLabel("error"), connecting: statusLabel("connecting"),
  }, {
    idle: "✓ Git Sync Vault", pulling: "↓ Syncing…", pushing: "↑ Syncing…",
    conflict: "⚠ Conflict", error: "✗ Sync Error", connecting: "… Connecting",
  });
});

test("tooltip explains pending work, skipped polls, and conflict pause", () => {
  const d = diagnostics();
  d.queue.pendingCount = 3;
  d.polling.lastOutcome = "skipped-local-work";
  assert.match(buildStatusTooltip(d, 10_000), /Waiting to sync/);
  assert.match(buildStatusTooltip(d, 10_000), /skipped — local work/);
  d.queue.conflictPaused = true;
  assert.match(buildStatusTooltip(d, 10_000), /Remote polling: Paused during conflict/);
});
