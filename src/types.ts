export interface PluginSettings {
  clientId: string;              // user's own GitHub OAuth App Client ID (required to connect)
  githubToken: string;           // OAuth access token (stored locally)
  githubUsername: string;        // Authenticated GitHub username
  repoName: string;              // e.g. "obsidian-my-vault"
  autoSync: boolean;             // auto-sync on file changes
  syncIntervalMs: number;        // debounce window
  excludePatterns: string[];     // glob patterns to ignore (e.g. ".obsidian/workspace")
  lastSyncTime: number;          // unix timestamp of last successful sync
  commitMessageTemplate: string; // e.g. "sync: {{datetime}}"
}

export const DEFAULT_SETTINGS: PluginSettings = {
  clientId: "",
  githubToken: "",
  githubUsername: "",
  repoName: "",
  autoSync: true,
  syncIntervalMs: 3000,
  excludePatterns: [
    // Never sync the .obsidian config dir: plugin code, themes, and device-local
    // state differ per device (and between desktop/mobile) and cause conflicts.
    // Each device manages its own plugins/config; only notes & attachments sync.
    ".obsidian/*",
  ],
  lastSyncTime: 0,
  commitMessageTemplate: "sync: {{datetime}}",
};

export interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubUser {
  login: string;
  id: number;
  name: string;
  email: string;
}

export interface GitHubRepo {
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  html_url: string;
}

export type SyncStatus =
  | "idle"
  | "pulling"
  | "pushing"
  | "conflict"
  | "error"
  | "connecting";

export interface ConflictFile {
  conflictSessionId: string; // unique token for the merge/conflict state that produced this file
  path: string;
  ours: string;   // local file content
  theirs: string; // remote file content
  oursExists: boolean;
  theirsExists: boolean;
  isBinary: boolean;
  oursBytes?: number[];
  theirsBytes?: number[];
}

export interface ConflictChoice {
  exists: boolean;
  content: string | Uint8Array;
}

export interface ConflictResolutionResult {
  completed: boolean; // true once every conflict in the active session has been resolved and pushed
  stale: boolean;     // true when the UI is resolving an old conflict session
  conflictFiles?: ConflictFile[]; // new conflicts found while retrying the resolved merge's push
  message?: string;
}

export interface SyncResult {
  success: boolean;
  conflictFiles: ConflictFile[];
  error?: string;
  logs?: string[];  // step-by-step diagnostic trace (shown on mobile where no console is reachable)
}
