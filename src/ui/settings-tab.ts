import { App, PluginSettingTab, Setting, Notice, ButtonComponent } from "obsidian";
import type MultiSyncPlugin from "../main";
import { requestDeviceCode, pollForToken } from "../auth/github-device";
import { getAuthenticatedUser } from "../github/api";
import type { DeviceFlowResponse } from "../types";

type DeviceFlowElement = HTMLElement & {
  createDiv(options?: { cls?: string }): DeviceFlowElement;
  createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: { text?: string; cls?: string; href?: string }
  ): HTMLElementTagNameMap[K] & DeviceFlowElement;
};

export function renderDeviceFlowPanel(
  containerEl: DeviceFlowElement,
  deviceFlow: DeviceFlowResponse,
  copyCode: () => Promise<void>
): HTMLElement {
  containerEl.querySelector(".gitsyncvault-device-flow")?.remove();
  const panel = containerEl.createDiv({ cls: "gitsyncvault-device-flow" });
  panel.createEl("p", {
    text: "Open this URL in your browser and enter the code below:",
  });
  const link = panel.createEl("a", {
    text: deviceFlow.verification_uri,
    href: deviceFlow.verification_uri,
  });
  link.addClass("gitsyncvault-device-flow-link");
  panel.createDiv({ cls: "gitsyncvault-user-code" }).setText(deviceFlow.user_code);
  const copyButton = panel.createEl("button", {
    text: "Copy code",
    cls: "gitsyncvault-copy-code",
  });
  copyButton.addEventListener("click", () => void copyCode());
  panel.createEl("p", {
    text: "Waiting for you to approve in the browser…",
    cls: "setting-item-description",
  });
  return panel;
}

export class MultiSyncSettingsTab extends PluginSettingTab {
  plugin: MultiSyncPlugin;
  private authAttemptGeneration = 0;
  private activeAuthAttempt: number | null = null;

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
              this.plugin.disconnectSyncEngine();
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
          this.plugin.updateAutoSync(val);
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
      .setDesc("One pattern per line. Common OS metadata is ignored automatically.")
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

    containerEl.createEl("h4", { text: "Selected Obsidian settings" });
    containerEl.createEl("p", {
      text: "Optional exceptions to the config-directory exclusion. Only the named Obsidian files are included; plugin data and workspace state stay excluded.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Files & links")
      .setDesc("Sync app.json, including attachment, link-format, auto-update, and wikilink preferences. Also includes other Files & Links preferences stored in that file.")
      .addToggle((toggle) => toggle.setValue(settings.syncObsidianFilesAndLinks).onChange(async (val) => {
        settings.syncObsidianFilesAndLinks = val;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Hotkeys")
      .setDesc("Sync hotkeys.json. Opt in only after reviewing explicit Ctrl/Meta/Alt bindings on every operating system.")
      .addToggle((toggle) => toggle.setValue(settings.syncObsidianHotkeys).onChange(async (val) => {
        settings.syncObsidianHotkeys = val;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Appearance")
      .setDesc("Sync appearance.json preferences only. Themes and CSS snippet files are not included and must exist on each device.")
      .addToggle((toggle) => toggle.setValue(settings.syncObsidianAppearance).onChange(async (val) => {
        settings.syncObsidianAppearance = val;
        await this.plugin.saveSettings();
      }));

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
    if (this.activeAuthAttempt !== null) {
      this.authAttemptGeneration++;
      this.activeAuthAttempt = null;
      this.removeDeviceFlowPanel();
      btn.setButtonText("Connect GitHub").setDisabled(false);
      new Notice("Connection cancelled.");
      return;
    }

    const clientId = this.plugin.settings.clientId;
    if (!clientId) {
      new Notice(
        "Enter your GitHub OAuth App's Client ID above before connecting."
      );
      return;
    }

    const attempt = ++this.authAttemptGeneration;
    this.activeAuthAttempt = attempt;
    this.removeDeviceFlowPanel();
    btn.setButtonText("Connecting…").setDisabled(true);

    try {
      const deviceFlow = await this.requestDeviceCode(clientId);
      if (!this.isCurrentAuthAttempt(attempt)) return;

      // Show the user their one-time code
      const panel = renderDeviceFlowPanel(
        this.containerEl as DeviceFlowElement,
        deviceFlow,
        () => this.copyDeviceCode(deviceFlow.user_code)
      );

      // Restore button so the user can cancel / retry while waiting
      btn.setButtonText("Cancel").setDisabled(false);

      // Open browser automatically
      window.open(deviceFlow.verification_uri, "_blank");

      // Poll until approved
      const token = await this.pollForToken(
        clientId,
        deviceFlow.device_code,
        deviceFlow.interval,
        deviceFlow.expires_in
      );
      if (!this.isCurrentAuthAttempt(attempt)) return;

      // Get user info
      const user = await this.getAuthenticatedUser(token);
      if (!this.isCurrentAuthAttempt(attempt)) return;
      this.plugin.settings.githubToken    = token;
      this.plugin.settings.githubUsername = user.login;

      // Initialise the repo
      await this.plugin.initializeRepo(token, user.login);
      if (!this.isCurrentAuthAttempt(attempt)) return;

      await this.plugin.saveSettings();
      if (!this.isCurrentAuthAttempt(attempt)) return;
      panel.remove();
      this.activeAuthAttempt = null;
      new Notice(`Connected as @${user.login}. Vault syncing started!`);
      this.display();
    } catch (err) {
      if (!this.isCurrentAuthAttempt(attempt)) return;
      const msg = err instanceof Error ? err.message : String(err);
      // Remove the code panel if it's still visible
      this.removeDeviceFlowPanel();
      this.activeAuthAttempt = null;
      new Notice(`Connection failed: ${msg}`);
      btn.setButtonText("Connect GitHub").setDisabled(false);
    }
  }

  private isCurrentAuthAttempt(attempt: number): boolean {
    return this.activeAuthAttempt === attempt;
  }

  private removeDeviceFlowPanel(): void {
    this.containerEl.querySelector(".gitsyncvault-device-flow")?.remove();
  }

  private async copyDeviceCode(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      new Notice("Device code copied.");
    } catch {
      new Notice("Could not copy the device code. Select it and copy it manually.");
    }
  }

  protected requestDeviceCode(clientId: string): Promise<DeviceFlowResponse> {
    return requestDeviceCode(clientId);
  }

  protected pollForToken(
    clientId: string,
    deviceCode: string,
    intervalSeconds: number,
    expiresIn: number
  ): Promise<string> {
    return pollForToken(clientId, deviceCode, intervalSeconds, expiresIn);
  }

  protected getAuthenticatedUser(token: string): Promise<{ login: string }> {
    return getAuthenticatedUser(token);
  }
}
