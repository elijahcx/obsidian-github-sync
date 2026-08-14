import { App, PluginSettingTab, Setting, Notice, ButtonComponent } from "obsidian";
import type MultiSyncPlugin from "../main";
import { requestDeviceCode, pollForToken } from "../auth/github-device";
import { getAuthenticatedUser } from "../github/api";

export class MultiSyncSettingsTab extends PluginSettingTab {
  plugin: MultiSyncPlugin;

  constructor(app: App, plugin: MultiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Git Sync Vault Settings" });

    const settings = this.plugin.settings;

    // ── Account section ──────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "GitHub Account" });

    if (settings.githubToken && settings.githubUsername) {
      // Connected state
      new Setting(containerEl)
        .setName("Connected account")
        .setDesc(`Signed in as @${settings.githubUsername}`)
        .addButton((btn) =>
          btn
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              settings.githubToken = "";
              settings.githubUsername = "";
              settings.repoName = "";
              await this.plugin.saveSettings();
              this.display();
              new Notice("Disconnected from GitHub.");
            })
        );

      new Setting(containerEl)
        .setName("Vault repo")
        .setDesc(`github.com/${settings.githubUsername}/${settings.repoName}`);
    } else {
      // Disconnected state
      new Setting(containerEl)
        .setName("GitHub OAuth Client ID")
        .setDesc(
          "Required. Register a GitHub OAuth App with Device Flow enabled and paste its Client ID here. See the plugin README for step-by-step instructions."
        )
        .addText((text) =>
          text
            .setPlaceholder("Ov23li…")
            .setValue(settings.clientId)
            .onChange(async (val) => {
              settings.clientId = val.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Repository name")
        .setDesc(
          "The GitHub repo to sync this vault with. Use the SAME name on every device. " +
          "It will be created under your account if it doesn't exist. Leave blank to use the vault name."
        )
        .addText((text) =>
          text
            .setPlaceholder("my-vault")
            .setValue(settings.repoName)
            .onChange(async (val) => {
              settings.repoName = val.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Connect GitHub account")
        .setDesc(
          "Authorise Git Sync Vault to access your private repos. Opens a browser window."
        )
        .addButton((btn) => {
          btn
            .setButtonText("Connect GitHub")
            .setCta()
            .onClick(async () => {
              await this.startDeviceFlow(btn);
            });
        });
    }

    // ── Sync options ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Sync Options" });

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("Automatically sync when files are modified.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (val) => {
          settings.autoSync = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync debounce (ms)")
      .setDesc("Wait this many milliseconds after the last edit before syncing.")
      .addSlider((slider) =>
        slider
          .setLimits(1000, 10000, 500)
          .setValue(settings.syncIntervalMs)
          .setDynamicTooltip()
          .onChange(async (val) => {
            settings.syncIntervalMs = val;
            this.plugin.updateSyncIntervalMs(val);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Excluded patterns")
      .setDesc("One pattern per line. These files will never be synced.")
      .addTextArea((ta) =>
        ta
          .setValue(settings.excludePatterns.join("\n"))
          .onChange(async (val) => {
            settings.excludePatterns = val
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // ── Manual sync ───────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Manual Sync" });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Immediately push all local changes and pull remote changes.")
      .addButton((btn) =>
        btn.setButtonText("Sync Now").onClick(async () => {
          await this.plugin.triggerManualSync();
        })
      );

    // ── Last sync time ────────────────────────────────────────────────────────
    if (settings.lastSyncTime > 0) {
      const lastSync = new Date(settings.lastSyncTime).toLocaleString();
      containerEl.createEl("p", {
        text: `Last synced: ${lastSync}`,
        cls: "setting-item-description",
      });
    }
  }

  private async startDeviceFlow(btn: ButtonComponent): Promise<void> {
    const clientId = this.plugin.settings.clientId;
    if (!clientId) {
      new Notice(
        "Enter your GitHub OAuth App's Client ID above before connecting."
      );
      return;
    }

    btn.setButtonText("Connecting…").setDisabled(true);

    try {
      const deviceFlow = await requestDeviceCode(clientId);

      // Show the user their one-time code
      const modal = this.containerEl.createDiv({ cls: "multisync-device-modal" });
      modal.style.cssText =
        "background:var(--background-secondary);border-radius:8px;padding:16px;" +
        "margin-top:12px;text-align:center;";
      modal.createEl("p", {
        text: "Open this URL in your browser and enter the code below:",
      });
      const link = modal.createEl("a", {
        text: deviceFlow.verification_uri,
        href: deviceFlow.verification_uri,
      });
      link.style.display = "block";
      const codeEl = modal.createEl("h1", {
        text: deviceFlow.user_code,
        cls: "multisync-user-code",
      });
      // Explicit styling so the code is visible regardless of Obsidian theme
      codeEl.style.cssText =
        "font-size:2rem;letter-spacing:0.25em;font-weight:700;" +
        "color:var(--text-normal);background:var(--background-primary);" +
        "border:2px solid var(--interactive-accent);border-radius:6px;" +
        "padding:8px 24px;display:inline-block;margin:12px auto;font-family:monospace;";
      modal.createEl("p", {
        text: "Waiting for you to approve in the browser…",
        cls: "setting-item-description",
      });

      // Restore button so the user can cancel / retry while waiting
      btn.setButtonText("Cancel").setDisabled(false);

      // Open browser automatically
      window.open(deviceFlow.verification_uri, "_blank");

      // Poll until approved
      const token = await pollForToken(
        clientId,
        deviceFlow.device_code,
        deviceFlow.interval,
        deviceFlow.expires_in
      );

      modal.remove();

      // Get user info
      const user = await getAuthenticatedUser(token);
      this.plugin.settings.githubToken    = token;
      this.plugin.settings.githubUsername = user.login;

      // Initialise the repo
      await this.plugin.initializeRepo(token, user.login);

      await this.plugin.saveSettings();
      new Notice(`Connected as @${user.login}. Vault syncing started!`);
      this.display();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Remove the code panel if it's still visible
      this.containerEl.querySelector(".multisync-device-modal")?.remove();
      new Notice(`Connection failed: ${msg}`);
      btn.setButtonText("Connect GitHub").setDisabled(false);
    }
  }
}
