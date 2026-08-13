import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { GitSync } from "../../src/sync/git-sync";

const execFile = promisify(execFileCb);

export const exclude = (filepath: string) => filepath === ".obsidian" || filepath.startsWith(".obsidian/");

export async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

export class LocalAdapter {
  constructor(public basePath: string) {}

  private abs(p: string): string {
    return path.join(this.basePath, p);
  }

  async readBinary(p: string): Promise<ArrayBuffer> {
    const buf = await readFile(this.abs(p));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  async write(p: string, data: string): Promise<void> {
    await mkdir(path.dirname(this.abs(p)), { recursive: true });
    await writeFile(this.abs(p), data, "utf8");
  }

  async writeBinary(p: string, data: ArrayBuffer): Promise<void> {
    await mkdir(path.dirname(this.abs(p)), { recursive: true });
    await writeFile(this.abs(p), Buffer.from(data));
  }

  async remove(p: string): Promise<void> {
    await unlink(this.abs(p));
  }

  async mkdir(p: string): Promise<void> {
    await mkdir(this.abs(p), { recursive: true });
  }

  async list(p: string): Promise<{ files: string[]; folders: string[] }> {
    const root = this.abs(p);
    const entries = await readdir(root, { withFileTypes: true });
    const prefix = p ? `${p.replace(/\\/g, "/")}/` : "";
    return {
      files: entries.filter((e) => e.isFile()).map((e) => `${prefix}${e.name}`),
      folders: entries.filter((e) => e.isDirectory()).map((e) => `${prefix}${e.name}`),
    };
  }

  async stat(p: string): Promise<{ type: "file" | "folder"; size: number; mtime: number; ctime: number } | null> {
    try {
      const s = await stat(this.abs(p));
      return { type: s.isFile() ? "file" : "folder", size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
    } catch {
      return null;
    }
  }
}

export type Device = {
  name: string;
  dir: string;
  adapter: LocalAdapter;
  sync: GitSync;
  read: (file: string) => Promise<string>;
  write: (file: string, content: string) => Promise<void>;
  readBinary: (file: string) => Promise<Buffer>;
  writeBinary: (file: string, content: Uint8Array) => Promise<void>;
  exists: (file: string) => boolean;
};

export class GitHttpRemote {
  root = "";
  remotePath = "";
  url = "";
  private server?: ReturnType<typeof createServer>;

  async start(): Promise<void> {
    this.root = await mkdtemp(path.join(tmpdir(), "git-sync-tests-"));
    this.remotePath = path.join(this.root, "remote.git");
    await git(["init", "--bare", "--initial-branch=main", this.remotePath]);
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server did not expose a port");
    this.url = `http://127.0.0.1:${address.port}/remote.git`;
  }

  async seed(files: Record<string, string | Uint8Array>): Promise<void> {
    const seedDir = path.join(this.root, "seed");
    await mkdir(seedDir, { recursive: true });
    await git(["init", "--initial-branch=main"], seedDir);
    await git(["config", "user.name", "Test"], seedDir);
    await git(["config", "user.email", "test@example.com"], seedDir);
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(seedDir, file)), { recursive: true });
      await writeFile(path.join(seedDir, file), content, "utf8");
    }
    await git(["add", "."], seedDir);
    await git(["commit", "--allow-empty", "-m", "seed"], seedDir);
    await git(["remote", "add", "origin", this.remotePath], seedDir);
    await git(["push", "origin", "main"], seedDir);
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: req.headers["content-length"] ?? "",
        REMOTE_USER: "test",
      },
    });
    req.pipe(child.stdin);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", () => {});
    child.on("close", () => {
      const raw = Buffer.concat(chunks);
      const splitAt = raw.indexOf("\r\n\r\n");
      const headerText = raw.slice(0, splitAt).toString("utf8");
      const body = raw.slice(splitAt + 4);
      let status = 200;
      for (const line of headerText.split("\r\n")) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx);
        const value = line.slice(idx + 1).trim();
        if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else res.setHeader(key, value);
      }
      res.statusCode = status;
      res.end(body);
    });
  }
}

export async function makeDevice(remoteUrl: string, root: string, name: string): Promise<Device> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  const adapter = new LocalAdapter(dir);
  const sync = new GitSync(adapter as never, dir, "token", "test-user", "remote", exclude);
  (sync as unknown as { remoteUrl: string }).remoteUrl = remoteUrl;
  return {
    name,
    dir,
    adapter,
    sync,
    read: (file) => readFile(path.join(dir, file), "utf8"),
    write: async (file, content) => {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), content, "utf8");
    },
    readBinary: (file) => readFile(path.join(dir, file)),
    writeBinary: async (file, content) => {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), content);
    },
    exists: (file) => existsSync(path.join(dir, file)),
  };
}

/** Mobile-style adapter: repository root is the adapter itself and vaultPath is empty. */
export async function makeMobileDevice(remoteUrl: string, root: string, name: string): Promise<Device> {
  const device = await makeDevice(remoteUrl, root, name);
  const sync = new GitSync(device.adapter as never, "", "token", "test-user", "remote", exclude);
  (sync as unknown as { remoteUrl: string }).remoteUrl = remoteUrl;
  return { ...device, sync };
}

export async function withRemote<T>(seed: Record<string, string | Uint8Array>, fn: (ctx: { remote: GitHttpRemote; root: string }) => Promise<T>): Promise<T> {
  const remote = new GitHttpRemote();
  await remote.start();
  await remote.seed(seed);
  try {
    return await fn({ remote, root: remote.root });
  } finally {
    await remote.stop();
  }
}
