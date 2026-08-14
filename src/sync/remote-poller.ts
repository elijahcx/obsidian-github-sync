export type IntervalScheduler = (
  callback: () => void,
  intervalMs: number
) => number;

/**
 * Owns the single passive-poll timer and fences overlapping callbacks. The
 * caller supplies eligibility and pull behavior so this class has no UI side
 * effects and can be tested with a deterministic scheduler.
 */
export class RemotePoller {
  private timer: number | null = null;
  private inFlight = false;

  constructor(
    private readonly intervalMs: number,
    private readonly schedule: IntervalScheduler,
    private readonly clear: (timer: number) => void,
    private readonly canPoll: () => boolean,
    private readonly poll: () => Promise<void>,
    private readonly onError: (error: unknown) => void
  ) {}

  start(): number | null {
    if (this.timer !== null) return null;
    this.timer = this.schedule(() => { void this.tick(); }, this.intervalMs);
    return this.timer;
  }

  stop(): void {
    if (this.timer === null) return;
    this.clear(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.timer === null || this.inFlight || !this.canPoll()) return;
    this.inFlight = true;
    try {
      await this.poll();
    } catch (error) {
      this.onError(error);
    } finally {
      this.inFlight = false;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
