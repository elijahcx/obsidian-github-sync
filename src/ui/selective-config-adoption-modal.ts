import { App, Modal, Setting } from "obsidian";

export type SelectiveConfigAdoptionChoice = "synced" | "local" | "cancel";

export class SelectiveConfigAdoptionModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly categoryLabel: string,
    private readonly finish: (choice: SelectiveConfigAdoptionChoice) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Choose settings version");
    this.contentEl.createEl("p", {
      text: `${this.categoryLabel} settings already exist in the synced vault and differ from this device.`,
    });
    new Setting(this.contentEl)
      .setName("Use synced settings")
      .setDesc("Replace this device’s local settings file with the already-synced version.")
      .addButton((button) => button.setButtonText("Use synced settings").setCta().onClick(() => this.choose("synced")));
    new Setting(this.contentEl)
      .setName("Use this device’s settings")
      .setDesc("Keep the local file and include it in the next normal conflict-safe sync.")
      .addButton((button) => button.setButtonText("Use this device’s settings").onClick(() => this.choose("local")));
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.choose("cancel")));
  }

  onClose(): void {
    if (!this.settled) this.finish("cancel");
    this.contentEl.empty();
  }

  private choose(choice: SelectiveConfigAdoptionChoice): void {
    if (this.settled) return;
    this.settled = true;
    this.finish(choice);
    this.close();
  }
}
