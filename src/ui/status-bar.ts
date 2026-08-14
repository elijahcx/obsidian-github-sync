import { Plugin } from "obsidian";
import { SyncStatus } from "../types";
import { buildStatusTooltip, SyncDiagnostics } from "../diagnostics";

const STATUS_ICONS: Record<SyncStatus, string> = {
  idle:       "✓ Git Sync Vault",
  pulling:    "↓ Syncing…",
  pushing:    "↑ Syncing…",
  conflict:   "⚠ Conflict",
  error:      "✗ Sync Error",
  connecting: "… Connecting",
};

export function statusLabel(status: SyncStatus): string { return STATUS_ICONS[status]; }

export class StatusBarItem {
  private el: HTMLElement;

  constructor(plugin: Plugin) {
    this.el = plugin.addStatusBarItem();
    this.el.style.cursor = "pointer";
    this.set("idle");
  }

  set(status: SyncStatus, detail?: string): void {
    const label = statusLabel(status);
    // Details can contain transport or filesystem information; keep the public
    // status surface compact and put only curated state in the tooltip.
    this.el.setText(label);
    this.el.setAttribute("data-sync-status", status);
  }

  setDiagnostics(diagnostics: SyncDiagnostics): void {
    this.el.setAttribute("title", buildStatusTooltip(diagnostics));
  }

  onClick(handler: () => void): void {
    this.el.addEventListener("click", handler);
  }
}
