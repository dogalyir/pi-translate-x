export class UIQueueBusyError extends Error {
  constructor(message = "Questionnaire UI is busy with another active request") {
    super(message);
    this.name = "UIQueueBusyError";
  }
}

export class UIQueueAbortError extends Error {
  constructor(message = "Operation aborted") {
    super(message);
    this.name = "AbortError";
  }
}

interface QueuedEntry {
  readonly run: () => void;
  readonly reject: (err: unknown) => void;
  cleanup: () => void;
}

export class UIQueue {
  private active = false;
  private readonly maxQueue: number;
  private activeController?: AbortController | undefined;
  private queue: QueuedEntry[] = [];

  constructor(maxQueue = 1) {
    this.maxQueue = maxQueue;
  }

  public get isBusy(): boolean {
    return this.active;
  }

  public get pendingCount(): number {
    return this.queue.length;
  }

  public reset(reason: string): void {
    const abortErr = new UIQueueAbortError(reason);
    if (this.activeController) {
      this.activeController.abort(reason);
      this.activeController = undefined;
    }
    // Note: Do NOT set this.active = false here while an active callback is still draining.
    // No overlapping owned screens permitted: reset ensures next UI cannot enter until active callback actually unwinds.

    const entries = this.queue;
    this.queue = [];
    for (const entry of entries) {
      try {
        entry.cleanup();
        entry.reject(abortErr);
      } catch {
        /* ignore */
      }
    }
  }

  public async runExclusive<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (callerSignal?.aborted) {
      throw callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new UIQueueAbortError(callerSignal.reason ? String(callerSignal.reason) : "Operation aborted");
    }

    if (this.active) {
      if (this.queue.length >= this.maxQueue) {
        throw new UIQueueBusyError();
      }

      await new Promise<void>((resolve, reject) => {
        let entry: QueuedEntry;

        const onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
          }
          entry.cleanup();
          reject(
            callerSignal?.reason instanceof Error
              ? callerSignal.reason
              : new UIQueueAbortError("Operation aborted while queued"),
          );
        };

        const cleanup = () => {
          if (callerSignal) {
            callerSignal.removeEventListener("abort", onAbort);
          }
        };

        if (callerSignal) {
          callerSignal.addEventListener("abort", onAbort, { once: true });
        }

        entry = {
          run: () => {
            cleanup();
            resolve();
          },
          reject,
          cleanup,
        };

        this.queue.push(entry);
      });
    }

    // Now active: assign controller
    this.active = true;
    const controller = new AbortController();
    this.activeController = controller;

    const forwardAbort = () => {
      controller.abort(callerSignal?.reason);
    };

    if (callerSignal) {
      callerSignal.addEventListener("abort", forwardAbort, { once: true });
    }

    try {
      return await operation(controller.signal);
    } finally {
      if (callerSignal) {
        callerSignal.removeEventListener("abort", forwardAbort);
      }

      if (this.activeController === controller) {
        this.activeController = undefined;
      }

      // Slot is released only when active callback actually unwinds
      if (this.queue.length > 0) {
        const next = this.queue.shift()!;
        next.run();
      } else {
        this.active = false;
      }
    }
  }
}
