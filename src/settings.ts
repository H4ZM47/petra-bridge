import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { randomBytes } from "crypto";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CONFIG_DIR, TOKEN_FILE } from "./shared";
import type PetraBridge from "./main";

export class PetraSettingTab extends PluginSettingTab {
  plugin: PetraBridge;
  private showFullToken = false;

  constructor(app: App, plugin: PetraBridge) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private getTokenPath(): string {
    return join(homedir(), CONFIG_DIR, TOKEN_FILE);
  }

  private getToken(): string | null {
    const tokenPath = this.getTokenPath();
    if (!existsSync(tokenPath)) {
      return null;
    }
    try {
      return readFileSync(tokenPath, "utf-8").trim();
    } catch {
      return null;
    }
  }

  private maskToken(token: string): string {
    if (token.length <= 8) return "****";
    return token.slice(0, 4) + "..." + token.slice(-4);
  }

  private validateTokenFormat(token: string): { valid: boolean; message: string } {
    // Accept any token with at least 20 characters for security
    if (token.length < 20) {
      return { valid: false, message: `Token too short (${token.length} chars, minimum 20)` };
    }

    // Allow alphanumeric plus base64url characters
    const safeCharsRegex = /^[A-Za-z0-9_-]+$/;
    if (!safeCharsRegex.test(token)) {
      return { valid: false, message: "Invalid characters detected" };
    }

    return { valid: true, message: `Valid (${token.length} characters)` };
  }

  private regenerateToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private saveToken(token: string): void {
    const configDir = join(homedir(), CONFIG_DIR);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    const tokenPath = this.getTokenPath();
    writeFileSync(tokenPath, token, { mode: 0o600 });
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Header
    new Setting(containerEl).setName("Server configuration").setHeading();

    // Bridge status
    const statusContainer = containerEl.createDiv({ cls: "petra-status" });
    const serverRunning = this.plugin.server !== null;

    new Setting(statusContainer)
      .setName("Bridge status")
      .setDesc(serverRunning ? "Server is running on port 27182" : "Server is not running")
      .setClass(serverRunning ? "petra-status-ok" : "petra-status-error");

    // Token section
    new Setting(containerEl).setName("Authentication token").setHeading();

    const token = this.getToken();
    const tokenPath = this.getTokenPath();

    if (!token) {
      new Setting(containerEl)
        .setName("Token status")
        .setDesc("No token found. Click the generate button to create one.")
        .setClass("petra-status-warning");
    } else {
      const validation = this.validateTokenFormat(token);

      // Token display
      const tokenDisplay = new Setting(containerEl)
        .setName("Current token")
        .setDesc(`Path: ${tokenPath}`)
        .addButton(button => button
          .setButtonText(this.showFullToken ? "Hide" : "Show Full")
          .onClick(() => {
            this.showFullToken = !this.showFullToken;
            this.display(); // Refresh display
          }))
        .addButton(button => button
          .setButtonText("Copy")
          .setTooltip("Copy token to clipboard")
          .onClick(() => {
            navigator.clipboard.writeText(token).then(() => {
              new Notice("Token copied to clipboard");
            }).catch(() => {
              new Notice("Failed to copy token", 3000);
            });
          }));

      // Show token value
      const tokenValueEl = tokenDisplay.descEl.createDiv({ cls: "petra-token-value" });
      tokenValueEl.createEl("code", {
        text: this.showFullToken ? token : this.maskToken(token),
        cls: "petra-token-code"
      });

      // Token validation status
      const validationSetting = new Setting(containerEl)
        .setName("Token validation")
        .setDesc(validation.message)
        .setClass(validation.valid ? "petra-status-ok" : "petra-status-error");

      if (validation.valid) {
        validationSetting.descEl.prepend(createSpan({ text: "OK ", cls: "petra-check" }));
      } else {
        validationSetting.descEl.prepend(createSpan({ text: "Error ", cls: "petra-error" }));
      }

      // Token info
      new Setting(containerEl)
        .setName("Token information")
        .setDesc(`Length: ${token.length} characters`);
    }

    // Token actions
    new Setting(containerEl).setName("Token management").setHeading();

    // Regenerate token
    new Setting(containerEl)
      .setName("Generate new token")
      .setDesc("Create a new secure authentication token. This will replace the existing token.")
      .addButton(button => button
        .setButtonText("Generate token")
        .setWarning()
        .onClick(() => {
          const newToken = this.regenerateToken();
          this.saveToken(newToken);

          // Update server with new token
          if (this.plugin.server) {
            this.plugin.server.setAuthToken(newToken);
          }

          new Notice("New token generated and applied");
          this.display(); // Refresh display
        }));

    // Manual token input
    let manualTokenValue = "";
    new Setting(containerEl)
      .setName("Set token manually")
      .setDesc("For advanced users: manually set a specific token value")
      .addText(text => text
        .setPlaceholder("Enter token (min 20 characters)")
        .onChange(value => {
          manualTokenValue = value;
        }))
      .addButton(button => button
        .setButtonText("Set token")
        .onClick(() => {
          if (!manualTokenValue) {
            new Notice("Please enter a token value", 3000);
            return;
          }

          const validation = this.validateTokenFormat(manualTokenValue);
          if (!validation.valid) {
            new Notice(`Invalid token: ${validation.message}`, 5000);
            return;
          }

          this.saveToken(manualTokenValue);

          // Update server with new token
          if (this.plugin.server) {
            this.plugin.server.setAuthToken(manualTokenValue);
          }

          new Notice("Token set and applied");
          this.display(); // Refresh display
        }));

    // Help section
    new Setting(containerEl).setName("Usage").setHeading();

    const helpEl = containerEl.createDiv({ cls: "petra-help-content" });
    helpEl.createEl("p", { text: "The token is used to authenticate API requests. Copy it and use in your CLI or automation tools:" });
    const codeBlock = helpEl.createEl("pre");
    codeBlock.createEl("code", { text: `# Example: Check vault info
curl -H "Authorization: Bearer <token>" http://localhost:27182/vault` });

  }
}
