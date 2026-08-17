// The GitHub OAuth App Client ID is supplied by the user in plugin settings —
// there is no build-time default. See README (§ Register a GitHub OAuth App).

export const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
export const GITHUB_TOKEN_URL  = "https://github.com/login/oauth/access_token";
export const GITHUB_API_BASE   = "https://api.github.com";

export const GIT_AUTHOR_NAME   = "Git Sync Vault";
export const GIT_AUTHOR_EMAIL  = "sync@obsidian.local";
export const SYNC_DEBOUNCE_MS  = 3000;
export const REMOTE_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_BRANCH    = "main";
