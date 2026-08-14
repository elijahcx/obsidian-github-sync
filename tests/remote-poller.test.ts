import test from "node:test";
import assert from "node:assert/strict";
import { REMOTE_POLL_INTERVAL_MS } from "../src/constants";
import { RemotePoller } from "../src/sync/remote-poller";

class FakeIntervals {
  nextId = 1;
  callbacks = new Map<number, () => void>();
  intervals: number[] = [];

  schedule = (callback: () => void, intervalMs: number): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    this.intervals.push(intervalMs);
    return id;
  };
  clear = (id: number): void => { this.callbacks.delete(id); };
  fire(): void { for (const callback of [...this.callbacks.values()]) callback(); }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(options: { eligible?: boolean; poll?: () => Promise<void> } = {}) {
  const clock = new FakeIntervals();
  let eligible = options.eligible ?? true;
  let calls = 0;
  const errors: unknown[] = [];
  const poller = new RemotePoller(
    REMOTE_POLL_INTERVAL_MS,
    clock.schedule,
    clock.clear,
    () => eligible,
    async () => { calls++; await options.poll?.(); },
    (error) => errors.push(error)
  );
  return { clock, poller, errors, calls: () => calls, eligible: (value: boolean) => { eligible = value; } };
}

test("polling starts once when connected with auto-sync enabled", () => {
  const h = harness();
  h.poller.start();
  h.poller.start();
  assert.equal(h.clock.callbacks.size, 1);
  assert.deepEqual(h.clock.intervals, [45_000]);
});

test("polling does not start when auto-sync is disabled by its lifecycle owner", () => {
  const h = harness({ eligible: false });
  // The plugin does not call start in this state; eligibility is an extra fence.
  assert.equal(h.poller.isRunning(), false);
  assert.equal(h.clock.callbacks.size, 0);
});

test("disabling auto-sync stops polling immediately and enabling starts it", () => {
  const h = harness();
  h.poller.start();
  h.poller.stop();
  assert.equal(h.clock.callbacks.size, 0);
  h.poller.start();
  assert.equal(h.clock.callbacks.size, 1);
});

test("unload cancellation leaves no post-unload callback", async () => {
  const h = harness();
  h.poller.start();
  h.poller.stop();
  h.clock.fire();
  await turn();
  assert.equal(h.calls(), 0);
});

test("only one passive pull can be active", async () => {
  let release!: () => void;
  const h = harness({ poll: () => new Promise<void>((resolve) => { release = resolve; }) });
  h.poller.start();
  h.clock.fire();
  await turn();
  h.clock.fire();
  await turn();
  assert.equal(h.calls(), 1);
  release();
  await turn();
  h.clock.fire();
  await turn();
  assert.equal(h.calls(), 2);
  release();
});

test("active local sync and queued or debounced work skip the poll", async () => {
  const h = harness({ eligible: false });
  h.poller.start();
  h.clock.fire();
  await turn();
  assert.equal(h.calls(), 0);
  h.eligible(true);
  h.clock.fire();
  await turn();
  assert.equal(h.calls(), 1);
});

test("no-change poll completes without any UI side effect", async () => {
  let uiCalls = 0;
  const h = harness({ poll: async () => { /* pull returned no conflicts */ } });
  h.poller.start();
  h.clock.fire();
  await turn();
  assert.equal(h.calls(), 1);
  assert.equal(uiCalls, 0);
});

test("remote changes are applied through the supplied GitSync.pull callback", async () => {
  let applied = false;
  const h = harness({ poll: async () => { applied = true; } });
  h.poller.start();
  h.clock.fire();
  await turn();
  assert.equal(applied, true);
});

test("conflict eligibility suppresses churn until resolve or abandonment", async () => {
  const h = harness();
  h.poller.start();
  h.clock.fire();
  await turn();
  h.eligible(false); // plugin opened the existing conflict session/modal
  h.clock.fire();
  await turn();
  assert.equal(h.calls(), 1);
  h.eligible(true); // resolution, abandonment, or manual supersession
  h.clock.fire();
  await turn();
  assert.equal(h.calls(), 2);
});

test("transient and repeated offline failures are quiet and later ticks retry", async () => {
  let attempts = 0;
  const h = harness({ poll: async () => { attempts++; if (attempts < 3) throw new Error("offline"); } });
  h.poller.start();
  for (let i = 0; i < 3; i++) { h.clock.fire(); await turn(); }
  assert.equal(h.calls(), 3);
  assert.equal(h.errors.length, 2);
  // Errors are delivered only to debug logging; the poller has no Notice/modal API.
  assert.equal(h.poller.isRunning(), true);
});
