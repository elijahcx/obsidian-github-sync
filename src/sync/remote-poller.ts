import { RemotePollDiagnostics, RemotePollOutcome } from "../types";

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
  private enabled = false;
  private lastAttemptAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastOutcome: RemotePollOutcome | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly schedule: IntervalScheduler,
    private readonly clear: (timer: number) => void,
    private readonly skipReason: () => Exclude<RemotePollOutcome, "success" | "no-change" | "offline/error"> | null,
    private readonly poll: () => Promise<"success" | "no-change" | "skipped-conflict" | void>,
    private readonly onError: (error: unknown) => void,
    private readonly onDiagnosticsChange: () => void = () => {},
    private readonly now: () => number = Date.now
  ) {}

  start(): number | null {
    if (this.timer !== null) return null;
    this.enabled = true;
    this.timer = this.schedule(() => { void this.tick(); }, this.intervalMs);
    this.onDiagnosticsChange();
    return this.timer;
  }

  stop(): void {
    this.enabled = false;
    if (this.timer !== null) this.clear(this.timer);
    this.timer = null;
    this.onDiagnosticsChange();
  }

  async tick(): Promise<void> {
    if (this.timer === null || this.inFlight) return;
    this.lastAttemptAt = this.now();
    const skipped = this.skipReason();
    if (skipped) {
      this.lastOutcome = skipped;
      this.onDiagnosticsChange();
      return;
    }
    this.inFlight = true;
    this.onDiagnosticsChange();
    try {
      const outcome = await this.poll();
      this.lastOutcome = outcome ?? "success";
      if (this.lastOutcome === "success" || this.lastOutcome === "no-change") {
        this.lastSuccessAt = this.now();
      }
    } catch (error) {
      this.lastOutcome = "offline/error";
      this.onError(error);
    } finally {
      this.inFlight = false;
      this.onDiagnosticsChange();
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  getDiagnostics(): RemotePollDiagnostics {
    return {
      enabled: this.enabled,
      running: this.timer !== null,
      inFlight: this.inFlight,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastOutcome: this.lastOutcome,
    };
  }
}
