import test from "node:test";
import assert from "node:assert/strict";
import { git, makeDevice, withEmptyRemote, withRemote } from "./helpers/harness";

const CANONICAL_FETCH = "+refs/heads/*:refs/remotes/origin/*";

type FetchInternals = { safeFetch: () => Promise<string | null>; lastFetchError: string | null };

async function removeFetchRefspec(dir: string): Promise<void> {
  await git(["config", "--unset-all", "remote.origin.fetch"], dir);
}

test("sync repairs a missing origin fetch refspec without changing a clean note", async () => {
  await withRemote({ "note.md": "unchanged\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "missing-refspec");
    await git(["clone", remote.url, device.dir]);
    await removeFetchRefspec(device.dir);

    const before = await device.read("note.md");
    const result = await device.sync.sync([]);

    assert.equal(result.success, true, result.error);
    assert.equal(await git(["config", "--get", "remote.origin.fetch"], device.dir), CANONICAL_FETCH);
    assert.equal(await device.read("note.md"), before);
  });
});

test("canonical origin configuration is idempotent and fetch behavior is unchanged", async () => {
  await withRemote({ "note.md": "remote\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "canonical-refspec");
    await git(["clone", remote.url, device.dir]);
    const configBefore = await git(["config", "--local", "--list"], device.dir);

    const head = await (device.sync as unknown as FetchInternals).safeFetch();

    assert.equal(head, await git(["rev-parse", "refs/remotes/origin/main"], device.dir));
    assert.equal(await git(["config", "--local", "--list"], device.dir), configBefore);
  });
});

test("initAndPush creates the origin URL and canonical fetch refspec", async () => {
  await withEmptyRemote(async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "init-origin-config");
    await device.write("note.md", "initial\n");

    await device.sync.initAndPush(["note.md"]);

    assert.equal(await git(["config", "--get", "remote.origin.url"], device.dir), remote.url);
    assert.equal(await git(["config", "--get", "remote.origin.fetch"], device.dir), CANONICAL_FETCH);
  });
});

test("partial clone recovery establishes complete origin configuration and fetches", async () => {
  await withRemote({ "note.md": "remote recovery\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "partial-clone");
    await git(["init", "--initial-branch=main"], device.dir);
    await git(["config", "remote.origin.url", remote.url], device.dir);

    assert.equal(await device.sync.clone(), true);
    assert.equal(await device.read("note.md"), "remote recovery\n");
    assert.equal(await git(["config", "--get", "remote.origin.fetch"], device.dir), CANONICAL_FETCH);
    assert.equal(await git(["rev-parse", "HEAD"], device.dir), await git(["rev-parse", "refs/remotes/origin/main"], device.dir));
  });
});

test("repair replaces a malformed fetch refspec without changing worktree, index, or HEAD", async () => {
  await withRemote({ "tracked.md": "base\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "malformed-refspec");
    await git(["clone", remote.url, device.dir]);
    await device.write("tracked.md", "unstaged local edit\n");
    await device.write("staged.md", "staged local file\n");
    await git(["add", "staged.md"], device.dir);
    await git(["config", "--replace-all", "remote.origin.fetch", "+refs/heads/main:refs/remotes/wrong/main"], device.dir);
    const headBefore = await git(["rev-parse", "HEAD"], device.dir);
    const indexBefore = await git(["write-tree"], device.dir);

    const fetched = await (device.sync as unknown as FetchInternals).safeFetch();

    assert.ok(fetched);
    assert.equal(await git(["config", "--get", "remote.origin.fetch"], device.dir), CANONICAL_FETCH);
    assert.equal(await git(["rev-parse", "HEAD"], device.dir), headBefore);
    assert.equal(await git(["write-tree"], device.dir), indexBefore);
    assert.equal(await device.read("tracked.md"), "unstaged local edit\n");
    assert.equal(await device.read("staged.md"), "staged local file\n");
  });
});

test("transport failure remains visible after repairing the refspec", async () => {
  await withRemote({ "note.md": "remote\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "failed-after-repair");
    await git(["clone", remote.url, device.dir]);
    await removeFetchRefspec(device.dir);
    remote.setFailureStatus(401);
    const internals = device.sync as unknown as FetchInternals;

    assert.equal(await internals.safeFetch(), null);
    assert.equal(await git(["config", "--get", "remote.origin.fetch"], device.dir), CANONICAL_FETCH);
    assert.match(internals.lastFetchError ?? "", /fetch failed|authentication/i);
  });
});

test("routine fetch refuses a changed origin URL instead of repointing it", async () => {
  await withRemote({ "note.md": "remote\n" }, async ({ remote, root }) => {
    const device = await makeDevice(remote.url, root, "changed-origin");
    await git(["clone", remote.url, device.dir]);
    await git(["config", "remote.origin.url", "https://example.invalid/unrelated.git"], device.dir);
    await removeFetchRefspec(device.dir);
    const internals = device.sync as unknown as FetchInternals;

    assert.equal(await internals.safeFetch(), null);
    assert.match(internals.lastFetchError ?? "", /Refusing to fetch/);
    assert.equal(await git(["config", "--get", "remote.origin.url"], device.dir), "https://example.invalid/unrelated.git");
    await assert.rejects(git(["config", "--get", "remote.origin.fetch"], device.dir));
  });
});
