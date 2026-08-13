import { App, Modal, Setting, Component } from "obsidian";
import { ConflictChoice, ConflictFile } from "../types";
import { diffSummary } from "../sync/conflict";

type ResolveCallback = (filepath: string, choice: ConflictChoice, conflictSessionId: string) => Promise<void>;

export class ConflictModal extends Modal {
  private conflicts: ConflictFile[];
  private currentIndex = 0;
  private onResolve: ResolveCallback;
  private onAbandon: () => void;
  private component: Component;
  /** True once every conflict has been decided — suppresses the abandon callback. */
  private completed = false;

  constructor(
    app: App,
    conflicts: ConflictFile[],
    onResolve: ResolveCallback,
    onAbandon: () => void = () => {}
  ) {
    super(app);
    this.conflicts = conflicts;
    this.onResolve = onResolve;
    this.onAbandon = onAbandon;
    this.component = new Component();
  }

  onOpen(): void {
    this.component.load();
    this.renderCurrent();
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
    // Closed early (X / Esc / "Open in Editor") — nothing was merged, so tell the
    // caller to discard the pending merge rather than leave it half-applied.
    if (!this.completed) this.onAbandon();
  }

  private renderCurrent(): void {
    const conflict = this.conflicts[this.currentIndex];
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", {
      text: `Sync Conflict (${this.currentIndex + 1} / ${this.conflicts.length})`,
    });
    contentEl.createEl("p", {
      text: `File: ${conflict.path}`,
      cls: "conflict-filepath",
    });

    // Diff summary
    const diffEl = contentEl.createEl("pre", { cls: "conflict-diff" });
    diffEl.style.cssText =
      "background:var(--background-secondary);padding:8px;border-radius:4px;" +
      "overflow:auto;max-height:180px;font-size:12px;";
    diffEl.textContent = diffSummary(conflict);

    // Two-column layout
    const cols = contentEl.createDiv({ cls: "conflict-columns" });
    cols.style.cssText =
      "display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0;";

    // OURS
    const oursCol = cols.createDiv();
    oursCol.createEl("h4", { text: "Your version (this device)" });
    const oursPre = oursCol.createEl("pre");
    oursPre.style.cssText =
      "background:#1a3a1a;padding:8px;border-radius:4px;" +
      "overflow:auto;max-height:260px;font-size:11px;white-space:pre-wrap;";
    oursPre.textContent =
      conflict.ours.slice(0, 2000) +
      (conflict.ours.length > 2000 ? "\n…(truncated)" : "");

    // THEIRS
    const theirsCol = cols.createDiv();
    theirsCol.createEl("h4", { text: "Remote version (other device)" });
    const theirsPre = theirsCol.createEl("pre");
    theirsPre.style.cssText =
      "background:#1a1a3a;padding:8px;border-radius:4px;" +
      "overflow:auto;max-height:260px;font-size:11px;white-space:pre-wrap;";
    theirsPre.textContent =
      conflict.theirs.slice(0, 2000) +
      (conflict.theirs.length > 2000 ? "\n…(truncated)" : "");

    // Action buttons
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Keep Mine").onClick(async () => {
          await this.resolve(conflict, this.choice(conflict, "ours"));
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Keep Theirs")
          .setCta()
          .onClick(async () => {
            await this.resolve(conflict, this.choice(conflict, "theirs"));
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Open in Editor").onClick(() => {
          this.close();
          this.app.workspace.openLinkText(conflict.path, "", true);
        })
      );
  }

  private choice(conflict: ConflictFile, side: "ours" | "theirs"): ConflictChoice {
    const exists = side === "ours" ? conflict.oursExists : conflict.theirsExists;
    const bytes = side === "ours" ? conflict.oursBytes : conflict.theirsBytes;
    const text = side === "ours" ? conflict.ours : conflict.theirs;
    return { exists, content: conflict.isBinary ? Uint8Array.from(bytes ?? []) : text };
  }

  private async resolve(conflict: ConflictFile, choice: ConflictChoice): Promise<void> {
    this.currentIndex++;
    // Mark complete BEFORE the last onResolve so close() doesn't abandon the merge
    // that this very call is about to apply.
    if (this.currentIndex >= this.conflicts.length) this.completed = true;
    await this.onResolve(conflict.path, choice, conflict.conflictSessionId);
    if (this.currentIndex < this.conflicts.length) {
      this.renderCurrent();
    } else {
      this.close();
    }
  }
}
