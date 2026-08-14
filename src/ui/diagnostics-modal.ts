import { App, Modal, Notice } from "obsidian";
import { buildDiagnosticReport, SyncDiagnostics } from "../diagnostics";

export class DiagnosticsModal extends Modal {
  constructor(app: App, private readonly diagnostics: SyncDiagnostics) { super(app); }

  onOpen(): void {
    this.titleEl.setText("Git Sync Vault: Sync diagnostics");
    const report = buildDiagnosticReport(this.diagnostics);
    const pre = this.contentEl.createEl("pre");
    pre.style.cssText = "white-space:pre-wrap;user-select:text;font-size:12px;";
    pre.setText(report);
    const button = this.contentEl.createEl("button", { text: "Copy diagnostics" });
    button.onclick = async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(report);
        new Notice("Diagnostics copied.");
      } catch {
        new Notice("Could not copy diagnostics.");
      }
    };
  }

  onClose(): void { this.contentEl.empty(); }
}
