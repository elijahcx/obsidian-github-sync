import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rename } from "node:fs/promises";
import { git, makeDevice, makeMobileDevice, withRemote } from "./helpers/harness";

test("Linux paths preserve case, spaces, special characters, Unicode, and deep nesting", async () => {
  await withRemote({}, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "linux");
    await a.sync.clone();
    const files = [
      "Case.md", "case.md", "name with spaces & symbols (1).md",
      "deep/one/two/three/four/note...md", "Café/æøå 😀/日本語 note.md",
      "CON.md", "auxiliary.name...md",
    ];
    for (const [index, file] of files.entries()) await a.write(file, `content-${index}\n`);
    const result = await a.sync.sync(files.map((file) => file.replace(/\//g, "\\")));
    assert.equal(result.success, true, result.error);

    const verifier = await makeDevice(remote.url, root, "linux-verifier");
    assert.equal(await verifier.sync.clone(), true);
    for (const [index, file] of files.entries()) assert.equal(await verifier.read(file), `content-${index}\n`);
  });
});

test("case-only rename is represented when the filesystem supports it", async () => {
  await withRemote({ "note.md": "case rename\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "case-rename");
    await a.sync.clone();
    await rename(path.join(a.dir, "note.md"), path.join(a.dir, "Note.md"));
    const result = await a.sync.sync(["note.md", "Note.md"]);
    assert.equal(result.success, true, result.error);
    assert.equal((await git(["ls-tree", "-r", "--name-only", "main"], a.dir)).includes("Note.md"), true);
    assert.equal((await git(["ls-tree", "-r", "--name-only", "main"], a.dir)).includes("note.md"), false);
  });
});

test("binary attachments survive clone, divergent merge, pull, and push byte-for-byte", async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]);
  const blob = Uint8Array.from({ length: 257 }, (_, i) => i % 256);
  await withRemote({ "note.md": "attachments\n", "assets/image.png": png }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "binary-a");
    const b = await makeDevice(remote.url, root, "binary-b");
    await a.sync.clone();
    await b.sync.clone();
    assert.deepEqual(await a.readBinary("assets/image.png"), Buffer.from(png));

    await a.writeBinary("assets/document.pdf", pdf);
    assert.equal((await a.sync.sync(["assets\\document.pdf"])).success, true);
    await b.writeBinary("assets/blob.bin", blob);
    const merged = await b.sync.sync(["assets\\blob.bin"]);
    assert.equal(merged.success, true, merged.error);
    assert.deepEqual(await b.readBinary("assets/document.pdf"), Buffer.from(pdf));

    await a.sync.sync([]);
    assert.deepEqual(await a.readBinary("assets/blob.bin"), Buffer.from(blob));
    assert.deepEqual(await a.readBinary("assets/image.png"), Buffer.from(png));
  });
});

test("large binary buffer survives synchronization without text decoding", async () => {
  await withRemote({}, async ({ remote, root }) => {
    const data = Uint8Array.from({ length: 512 * 1024 }, (_, i) => (i * 31) % 256);
    const a = await makeDevice(remote.url, root, "large-a");
    await a.sync.clone();
    await a.writeBinary("attachments/large.bin", data);
    assert.equal((await a.sync.sync(["attachments/large.bin"])).success, true);
    const b = await makeDevice(remote.url, root, "large-b");
    await b.sync.clone();
    assert.deepEqual(await b.readBinary("attachments/large.bin"), Buffer.from(data));
  });
});

test("mobile empty vault root supports clone, sync, rename, delete, exclusions, and pull", async () => {
  await withRemote({ "note.md": "base\n", ".obsidian/workspace.json": "remote\n" }, async ({ remote, root }) => {
    const a = await makeMobileDevice(remote.url, root, "mobile-a");
    const b = await makeMobileDevice(remote.url, root, "mobile-b");
    await a.write(".obsidian/workspace.json", "local-mobile\n");
    assert.equal(await a.sync.clone(), true);
    assert.equal(await b.sync.clone(), true);
    assert.equal(await a.read(".obsidian/workspace.json"), "local-mobile\n");

    await a.write("folder/mobile note.md", "mobile\n");
    assert.equal((await a.sync.sync(["folder\\mobile note.md"])).success, true);
    assert.equal((await b.sync.sync([])).success, true);
    assert.equal(await b.read("folder/mobile note.md"), "mobile\n");

    await rename(path.join(b.dir, "folder/mobile note.md"), path.join(b.dir, "folder/renamed.md"));
    assert.equal((await b.sync.sync(["folder\\mobile note.md", "folder\\renamed.md"])).success, true);
    await b.adapter.remove("note.md");
    assert.equal((await b.sync.sync(["note.md"])).success, true);
    assert.equal((await a.sync.sync([])).success, true);
    assert.equal(a.exists("note.md"), false);
    assert.equal(await a.read("folder/renamed.md"), "mobile\n");
  });
});

test("mobile empty vault root preserves conflict handling and non-fast-forward retry", async () => {
  await withRemote({ "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeMobileDevice(remote.url, root, "mobile-race-a");
    const b = await makeMobileDevice(remote.url, root, "mobile-race-b");
    await a.sync.clone();
    await b.sync.clone();

    const internals = a.sync as never as { safeFetch: () => Promise<string | null> };
    const realFetch = internals.safeFetch.bind(a.sync);
    const stale = await realFetch();
    assert.ok(stale);
    let fetches = 0;
    internals.safeFetch = async () => (++fetches === 1 ? stale : realFetch());

    await a.write("from-a.md", "A\n");
    await b.write("from-b.md", "B\n");
    assert.equal((await b.sync.sync(["from-b.md"])).success, true);
    const raced = await a.sync.sync(["from-a.md"]);
    assert.equal(raced.success, true, raced.error);
    assert.ok(raced.logs?.some((line) => line.includes("non-fast-forward")));

    await a.write("note.md", "A edit\n");
    await b.sync.sync([]);
    await b.write("note.md", "B edit\n");
    assert.equal((await a.sync.sync(["note.md"])).success, true);
    const conflict = await b.sync.sync(["note.md"]);
    assert.equal(conflict.success, false);
    assert.deepEqual(conflict.conflictFiles.map((file) => file.path), ["note.md"]);
  });
});

test("excluded binary working copy remains byte-for-byte local across remote update", async () => {
  const remoteV1 = Uint8Array.from([0, 1, 2, 3, 255]);
  const remoteV2 = Uint8Array.from([9, 8, 0, 7, 6]);
  const local = Uint8Array.from([0, 255, 0, 255, 42]);
  await withRemote({ ".obsidian/cache.bin": remoteV1, "note.md": "base\n" }, async ({ remote, root }) => {
    const a = await makeDevice(remote.url, root, "excluded-binary-a");
    const b = await makeDevice(remote.url, root, "excluded-binary-b");
    await a.sync.clone();
    await b.sync.clone();
    await b.writeBinary(".obsidian/cache.bin", local);

    await a.writeBinary(".obsidian/cache.bin", remoteV2);
    await git(["add", ".obsidian/cache.bin"], a.dir);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "binary config"], a.dir);
    await git(["push", "origin", "main"], a.dir);

    const result = await b.sync.sync([]);
    assert.equal(result.success, true, result.error);
    assert.deepEqual(await b.readBinary(".obsidian/cache.bin"), Buffer.from(local));
  });
});
