// The GitHub OAuth App Client ID is supplied by the user in plugin settings —
// there is no build-time default. See README (§ Register a GitHub OAuth App).

export const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
export const GITHUB_TOKEN_URL  = "https://github.com/login/oauth/access_token";
export const GITHUB_API_BASE   = "https://api.github.com";

export const PLUGIN_ID         = "gitsyncvault";
export const GIT_AUTHOR_NAME   = "Git Sync Vault";
export const GIT_AUTHOR_EMAIL  = "sync@obsidian.local";
export const GIT_DIR           = ".git";
export const SYNC_DEBOUNCE_MS  = 3000;
export const SYNC_ON_OPEN      = true;
export const SYNC_ON_CLOSE     = true;
export const DEFAULT_BRANCH    = "main";
