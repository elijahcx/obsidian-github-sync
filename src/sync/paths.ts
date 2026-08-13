/** Canonical form for every vault-relative path passed to Git. */
export function normalizeGitPath(filepath: string): string {
  return filepath
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .replace(/\/$/, "");
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
  return typeof filename === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.bin$/.test(filename);
}
