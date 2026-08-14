import { App, Modal, Setting, Component } from "obsidian";
import { ConflictChoice, ConflictFile } from "../types";
import { diffSummary } from "../sync/conflict";

export type ResolveOutcome = "accepted" | "replaced" | "rejected";
type ResolveCallback = (filepath: string, choice: ConflictChoice, conflictSessionId: string) => Promise<ResolveOutcome>;

export class ConflictModal extends Modal {
  private conflicts: ConflictFile[];
  private currentIndex = 0;
  private onResolve: ResolveCallback;
  private onAbandon: () => void;
  private component: Component;
  /** True once every conflict has been decided — suppresses the abandon callback. */
  private completed = false;
  private resolving = false;

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
      cls: "gitsyncvault-conflict-filepath",
    });

    // Diff summary
    const diffEl = contentEl.createEl("pre", { cls: "gitsyncvault-conflict-diff" });
    diffEl.textContent = diffSummary(conflict);

    // Two-column layout
    const cols = contentEl.createDiv({ cls: "gitsyncvault-conflict-columns" });

    // OURS
    const oursCol = cols.createDiv();
    oursCol.createEl("h4", { text: "Your version (this device)" });
    const oursPre = oursCol.createEl("pre", {
      cls: "gitsyncvault-conflict-version gitsyncvault-conflict-version-mine",
    });
    oursPre.textContent =
      conflict.ours.slice(0, 2000) +
      (conflict.ours.length > 2000 ? "\n…(truncated)" : "");

    // THEIRS
    const theirsCol = cols.createDiv();
    theirsCol.createEl("h4", { text: "Remote version (other device)" });
    const theirsPre = theirsCol.createEl("pre", {
      cls: "gitsyncvault-conflict-version gitsyncvault-conflict-version-theirs",
    });
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
    if (this.resolving) return;
    this.resolving = true;
    for (const button of Array.from(this.contentEl.querySelectorAll("button"))) {
      (button as HTMLButtonElement).disabled = true;
    }
    try {
      const outcome = await this.onResolve(conflict.path, choice, conflict.conflictSessionId);
      if (outcome === "rejected") {
        this.renderCurrent();
        return;
      }
      if (outcome === "replaced") {
        this.completed = true;
        this.close();
        return;
      }
      this.currentIndex++;
      if (this.currentIndex >= this.conflicts.length) {
        this.completed = true;
        this.close();
      } else {
        this.renderCurrent();
      }
    } catch (error) {
      this.renderCurrent();
      this.contentEl.createEl("p", {
        text: `Resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        cls: "mod-warning",
      });
    } finally {
      this.resolving = false;
    }
  }
}
