import test from "node:test";
import assert from "node:assert/strict";
import { Notice } from "obsidian";
import { MultiSyncSettingsTab, renderDeviceFlowPanel } from "../src/ui/settings-tab";
import type { DeviceFlowResponse } from "../src/types";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { open: () => null },
});

class FakeElement {
  children: FakeElement[] = [];
  parent?: FakeElement;
  text = "";
  cls = "";
  removed = false;
  listeners = new Map<string, () => void>();

  createDiv(options: { cls?: string } = {}): FakeElement {
    return this.createEl("div", options);
  }

  createEl(_tag: string, options: { text?: string; cls?: string } = {}): FakeElement {
    const child = new FakeElement();
    child.parent = this;
    child.text = options.text ?? "";
    child.cls = options.cls ?? "";
    this.children.push(child);
    return child;
  }

  addClass(cls: string): void { this.cls = cls; }
  setText(text: string): void { this.text = text; }
  addEventListener(event: string, listener: () => void): void { this.listeners.set(event, listener); }
  remove(): void {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
  querySelector(selector: string): FakeElement | null {
    const cls = selector.slice(1);
    for (const child of this.children) {
      if (child.cls.split(" ").includes(cls)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

const flow: DeviceFlowResponse = {
  device_code: "device",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

type FakeButton = {
  text: string;
  disabled: boolean;
  setButtonText(text: string): FakeButton;
  setDisabled(disabled: boolean): FakeButton;
};

function button(): FakeButton {
  return {
    text: "Connect GitHub", disabled: false,
    setButtonText(text) { this.text = text; return this; },
    setDisabled(disabled) { this.disabled = disabled; return this; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeTab(options: {
  request?: () => Promise<DeviceFlowResponse>;
  poll?: () => Promise<string>;
} = {}) {
  const container = new FakeElement();
  const settings = { clientId: "client", githubToken: "", githubUsername: "" };
  const plugin = {
    settings,
    initializeRepo: async () => {},
    saveSettings: async () => {},
  };
  const tab = Object.create(MultiSyncSettingsTab.prototype) as MultiSyncSettingsTab & Record<string, unknown>;
  Object.assign(tab, {
    plugin,
    containerEl: container,
    authAttemptGeneration: 0,
    activeAuthAttempt: null,
    display: () => {},
    requestDeviceCode: options.request ?? (async () => flow),
    pollForToken: options.poll ?? (async () => "token"),
    getAuthenticatedUser: async (token: string) => ({ login: `${token}-user` }),
  });
  return { tab, container, settings };
}

async function start(tab: MultiSyncSettingsTab, btn: FakeButton): Promise<void> {
  await (tab as unknown as { startDeviceFlow(btn: FakeButton): Promise<void> }).startDeviceFlow(btn);
}

test("renders the exact selectable device code and replaces a stale panel", () => {
  const container = new FakeElement();
  const stale = container.createDiv({ cls: "gitsyncvault-device-flow" });
  renderDeviceFlowPanel(container as never, flow, async () => {});
  assert.equal(stale.removed, true);
  assert.equal(container.children.filter((el) => el.cls === "gitsyncvault-device-flow").length, 1);
  assert.equal(container.querySelector(".gitsyncvault-user-code")?.text, "ABCD-EFGH");
});

test("successful and failed authorization both remove the panel", async () => {
  const success = fakeTab();
  await start(success.tab, button());
  assert.equal(success.container.querySelector(".gitsyncvault-device-flow"), null);

  const failure = fakeTab({ poll: async () => { throw new Error("expired"); } });
  await start(failure.tab, button());
  assert.equal(failure.container.querySelector(".gitsyncvault-device-flow"), null);
});

test("cancelled polling cannot overwrite a newer successful attempt", async () => {
  const oldPoll = deferred<string>();
  let polls = 0;
  const { tab, settings } = fakeTab({ poll: () => ++polls === 1 ? oldPoll.promise : Promise.resolve("new") });
  const btn = button();
  const oldAttempt = start(tab, btn);
  while (btn.text !== "Cancel") await Promise.resolve();
  await start(tab, btn); // Cancel and abandon the first attempt.
  await start(tab, btn); // Start a replacement attempt.
  assert.equal(settings.githubToken, "new");
  oldPoll.resolve("old");
  await oldAttempt;
  assert.equal(settings.githubToken, "new");
  assert.equal(settings.githubUsername, "new-user");
});

test("clipboard notices report success and do not report false success", async () => {
  const { tab } = fakeTab();
  const messages = (Notice as unknown as { messages: string[] }).messages;
  messages.length = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (code: string) => assert.equal(code, "ABCD-EFGH") } },
  });
  await (tab as unknown as { copyDeviceCode(code: string): Promise<void> }).copyDeviceCode("ABCD-EFGH");
  assert.deepEqual(messages, ["Device code copied."]);

  messages.length = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => { throw new Error("denied"); } } },
  });
  await (tab as unknown as { copyDeviceCode(code: string): Promise<void> }).copyDeviceCode("ABCD-EFGH");
  assert.deepEqual(messages, ["Could not copy the device code. Select it and copy it manually."]);
});
