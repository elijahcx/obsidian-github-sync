import { QueueDiagnostics, RemotePollDiagnostics, SyncStatus } from "./types";

export interface SyncDiagnostics {
  version: string;
  status: SyncStatus;
  connected: boolean;
  githubUsername: string;
  repoName: string;
  autoSync: boolean;
  debounceMs: number;
  remoteIntervalMs: number;
  lastSuccessfulSyncAt: number | null;
  queue: QueueDiagnostics;
  polling: RemotePollDiagnostics;
}

export const EMPTY_QUEUE_DIAGNOSTICS: QueueDiagnostics = {
  pendingCount: 0, active: false, debouncePending: false,
  conflictPaused: false, shuttingDown: false,
};

export const EMPTY_POLL_DIAGNOSTICS: RemotePollDiagnostics = {
  enabled: false, running: false, inFlight: false,
  lastAttemptAt: null, lastSuccessAt: null, lastOutcome: null,
};

export function formatTimestamp(value: number | null): string {
  return value === null ? "Never" : new Date(value).toLocaleString();
}

export function relativeTime(value: number | null, now = Date.now()): string {
  if (value === null) return "Never";
  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function yesNo(value: boolean): string { return value ? "yes" : "no"; }

function formatRemoteOutcome(outcome: RemotePollDiagnostics["lastOutcome"]): string {
  return outcome === "success" ? "check-completed" : outcome ?? "Never";
}

export function buildDiagnosticReport(d: SyncDiagnostics): string {
  return [
    "Git Sync Vault Diagnostics",
    `Version: ${d.version}`,
    `Status: ${d.status}`,
    `Connection: ${d.connected ? "connected" : "disconnected"}`,
    `GitHub username: ${d.githubUsername || "Not configured"}`,
    `Repository: ${d.repoName || "Not configured"}`,
    `Auto-sync: ${d.autoSync ? "enabled" : "disabled"}`,
    `Local debounce: ${d.debounceMs}ms`,
    `Remote polling: ${d.polling.enabled ? "enabled" : "disabled"}`,
    `Remote interval: ${Math.round(d.remoteIntervalMs / 1000)}s`,
    `Polling running: ${yesNo(d.polling.running)}`,
    `Poll in flight: ${yesNo(d.polling.inFlight)}`,
    `Last successful sync: ${formatTimestamp(d.lastSuccessfulSyncAt)}`,
    `Last remote attempt: ${formatTimestamp(d.polling.lastAttemptAt)}`,
    `Last remote success: ${formatTimestamp(d.polling.lastSuccessAt)}`,
    `Last remote outcome: ${formatRemoteOutcome(d.polling.lastOutcome)}`,
    `Pending files: ${d.queue.pendingCount}`,
    `Queue active: ${yesNo(d.queue.active)}`,
    `Debounce pending: ${yesNo(d.queue.debouncePending)}`,
    `Conflict paused: ${yesNo(d.queue.conflictPaused)}`,
    `Shutting down: ${yesNo(d.queue.shuttingDown)}`,
  ].join("\n");
}

export function buildStatusTooltip(d: SyncDiagnostics, now = Date.now()): string {
  const status = d.queue.conflictPaused ? "Conflict"
    : d.queue.pendingCount > 0 && d.status === "idle" ? "Waiting to sync"
    : d.status === "idle" ? "Synced" : d.status[0].toUpperCase() + d.status.slice(1);
  const polling = !d.polling.enabled ? "Off"
    : d.queue.conflictPaused ? "Paused during conflict"
    : `On (${Math.round(d.remoteIntervalMs / 1000)}s)`;
  const outcome = d.polling.lastOutcome?.startsWith("skipped-")
    ? `skipped — ${d.polling.lastOutcome.slice(8).replace(/-/g, " ")}`
    : relativeTime(d.polling.lastAttemptAt, now);
  return ["Git Sync Vault", `Status: ${status}`, `Last sync: ${relativeTime(d.lastSuccessfulSyncAt, now)}`,
    `Last remote check: ${outcome}`, `Pending files: ${d.queue.pendingCount}`, `Remote polling: ${polling}`].join("\n");
}
