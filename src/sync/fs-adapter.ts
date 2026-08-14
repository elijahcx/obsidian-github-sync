import { DataAdapter } from "obsidian";
import { normalizeGitPath, normalizeVaultPath } from "./paths";

type Stats = {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  // isomorphic-git requires these Node.js-style methods on stat results
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * Creates a fs-like object for isomorphic-git that wraps Obsidian's DataAdapter.
 * Paths passed by isomorphic-git are ABSOLUTE (prefixed with vaultPath).
 * We strip the vaultPath prefix before calling Obsidian's adapter (which uses relative paths).
 */
export function createFsAdapter(adapter: DataAdapter, vaultPath: string) {
  const base = normalizeVaultPath(vaultPath);
  /** Strip the vault root prefix so Obsidian adapter gets relative paths */
  function rel(absPath: string): string {
    const normalized = normalizeVaultPath(absPath);
    if (base === "") return normalizeGitPath(normalized);
    // The vault root itself (absPath === base) must map to "", not to `base`.
    // Otherwise adapter.list(base) looks for a subfolder literally named after
    // the vault dir, fails, and isomorphic-git sees an EMPTY working tree — every
    // tracked file then shows W=0 ("missing in workdir"), producing phantom
    // commits that never merge/pull. This is the mobile-only root-dir case.
    if (normalized === base) return "";
    if (normalized.startsWith(base + "/")) {
      return normalizeGitPath(normalized.slice(base.length + 1));
    }
    return normalizeGitPath(normalized);
  }

  const promises = {
    async readFile(
      path: string,
      options?: string | { encoding?: string }
    ): Promise<Buffer | string> {
      try {
        const content = await adapter.readBinary(rel(path));
        // isomorphic-git asks for text in TWO shapes: `{ encoding: "utf8" }` and a
        // BARE STRING `"utf8"` (see GitIgnoreManager.isIgnored, which reads
        // .gitignore via `fs.read(path, "utf8")`). Handling only the object form
        // returns a Buffer where a string was expected — the ignore parser then
        // silently matches nothing, so gitignored files (.obsidian/plugins/**)
        // show up as untracked and get reported as bogus "conflicts".
        const encoding =
          typeof options === "string" ? options : options?.encoding;
        if (encoding === "utf8" || encoding === "utf-8") {
          return Buffer.from(content).toString("utf8");
        }
        return Buffer.from(content);
      } catch (cause) {
        // Only claim ENOENT when the adapter can positively prove absence.
        // Permission/provider/transient failures must remain distinguishable.
        try {
          const existing = await adapter.stat(rel(path));
          if (existing) throw cause;
        } catch {
          throw cause;
        }
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async writeFile(path: string, data: string | Buffer | Uint8Array): Promise<void> {
      const relativePath = rel(path);
      // Ensure parent directory exists
      const parts = relativePath.split("/");
      if (parts.length > 1) {
        const dir = parts.slice(0, -1).join("/");
        try { await adapter.mkdir(dir); } catch { /* already exists */ }
      }
      if (typeof data === "string") {
        await adapter.write(relativePath, data);
      } else {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        await adapter.writeBinary(relativePath, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      }
    },

    async unlink(path: string): Promise<void> {
      try {
        await adapter.remove(rel(path));
      } catch {
        /* ignore if not found */
      }
    },

    async readdir(path: string): Promise<string[]> {
      try {
        const result = await adapter.list(rel(path));
        const files = result.files.map((f) => f.split("/").pop()!);
        const folders = result.folders.map((f) => f.split("/").pop()!);
        return [...folders, ...files];
      } catch {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, scandir '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async mkdir(path: string, _options?: unknown): Promise<void> {
      try {
        await adapter.mkdir(rel(path));
      } catch {
        /* already exists — ignore */
      }
    },

    async rmdir(_path: string): Promise<void> {
      /* isomorphic-git calls rmdir on cleanup — safe to no-op for now */
    },

    async stat(path: string): Promise<Stats> {
      let s;
      try {
        s = await adapter.stat(rel(path));
      } catch (cause) {
        throw cause;
      }
      if (!s) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, stat '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
      const isDir = s.type !== "file";
      return {
          type: isDir ? "dir" : "file",
          mode: isDir ? 0o040755 : 0o100644,
          size: s.size ?? 0,
          ino: 0,
          mtimeMs: s.mtime ?? Date.now(),
          ctimeMs: s.ctime ?? Date.now(),
          uid: 1,
          gid: 1,
          dev: 1,
          isFile: () => !isDir,
          isDirectory: () => isDir,
          isSymbolicLink: () => false,
      };
    },

    async lstat(path: string): Promise<Stats> {
      return promises.stat(path);
    },

    async readlink(path: string): Promise<string> {
      throw Object.assign(new Error(`EINVAL: readlink not supported '${path}'`), { code: "EINVAL" });
    },

    async symlink(): Promise<void> {
      throw Object.assign(new Error("EINVAL: symlink not supported"), { code: "EINVAL" });
    },

    async chmod(): Promise<void> {
      /* chmod is a no-op on mobile — isomorphic-git calls it but we can safely ignore */
    },
  };

  return { promises };
}
