/** Canonical form for every vault-relative path passed to Git. */
export function normalizeGitPath(filepath: string): string {
  return filepath
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

/** Operating-system bookkeeping files that are never vault content. */
export function isBuiltInIgnoredPath(filepath: string): boolean {
  const basename = normalizeGitPath(filepath).split("/").pop() ?? "";
  if (basename === ".DS_Store") return true;
  const windowsName = basename.toLowerCase();
  return windowsName === "thumbs.db" || windowsName === "desktop.ini";
}

/** Match the plugin's intentionally small, anchored `*` pattern language. */
export function matchesExcludePattern(filepath: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(normalizeGitPath(filepath));
}

/** Canonical root used by isomorphic-git; DataAdapter remains the native boundary. */
export function normalizeVaultPath(vaultPath: string): string {
  if (vaultPath === "") return "";
  const normalized = vaultPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

/** Security validation for untrusted vault-relative paths (for example journals). */
export function isSafeRelativePath(filepath: unknown): filepath is string {
  if (typeof filepath !== "string" || filepath.length === 0) return false;
  if (filepath.includes("\\") || filepath.startsWith("/") || filepath.startsWith("//")) return false;
  if (/^[A-Za-z]:/.test(filepath)) return false;
  const segments = filepath.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isSafeSnapshotBasename(filename: unknown): filename is string {
  return typeof filename === "string" && /^\d{10,}-[a-z0-9]+-\d+\.bin$/.test(filename);
}
