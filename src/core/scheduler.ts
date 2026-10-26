import { TranslationError, type TranslationRequest, type TranslationResult, type Translator } from "./contracts.js";
interface Consumer { requestId: string; signal: AbortSignal; resolve: (r: TranslationResult) => void; reject: (e: unknown) => void; abort: () => void; timer?: ReturnType<typeof setTimeout>; }
interface Job { key: string; priority: "input" | "output"; controller: AbortController; consumers: Set<Consumer>; started: boolean; settled: boolean; run: (signal: AbortSignal) => Promise<string>; }

export class TranslationScheduler {
  #queue: Job[] = []; #jobs = new Map<string, Job>(); #active = 0; #closed = false;
  constructor(private readonly translator: Translator, private readonly maxConcurrency = 2, private readonly reservedInputSlots = 1) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || !Number.isInteger(reservedInputSlots) || reservedInputSlots < 0 || reservedInputSlots >= maxConcurrency) throw new Error("Invalid scheduler capacity/reservation");
  }
  submit(request: TranslationRequest, priority: "input" | "output" = "input"): Promise<TranslationResult> {
    if (this.#closed) return Promise.reject(new TranslationError("aborted", "Scheduler is closed"));
    if (request.signal.aborted) return Promise.reject(new TranslationError("aborted", "Request aborted"));
    const key = JSON.stringify([request.sessionId, request.branchId, request.source, request.targetLanguage, request.modelRef]);
    let job = this.#jobs.get(key);
    if (!job || job.settled) {
      job = { key, priority, controller: new AbortController(), consumers: new Set(), started: false, settled: false, run: (signal) => this.translator.translate({ ...request, signal }).then((result) => result.text) };
      this.#jobs.set(key, job); this.#queue.push(job);
    }
    const target = job;
    const promise = new Promise<TranslationResult>((resolve, reject) => {
      const consumer: Consumer = { requestId: request.requestId, signal: request.signal, resolve, reject, abort: () => {} };
      const cancel = (reason: "aborted" | "timeout") => {
        if (!target.consumers.delete(consumer)) return;
        consumer.signal.removeEventListener("abort", consumer.abort);
        if (consumer.timer) clearTimeout(consumer.timer);
        reject(new TranslationError(reason, reason === "timeout" ? "Translation consumer timed out" : "Request aborted"));
        if (target.consumers.size === 0) {
          target.controller.abort(reason);
          this.#queue = this.#queue.filter((item) => item !== target);
          if (this.#jobs.get(target.key) === target) this.#jobs.delete(target.key);
          this.#finish(target, undefined, new TranslationError(reason, reason === "timeout" ? "Translation consumer timed out" : "All consumers cancelled"));
        }
      };
      consumer.abort = () => cancel("aborted");
      request.signal.addEventListener("abort", consumer.abort, { once: true });
      if (request.timeoutMs !== undefined) consumer.timer = setTimeout(() => cancel("timeout"), request.timeoutMs);
      target.consumers.add(consumer);
      if (priority === "input" && !target.started) { target.priority = "input"; this.#queue = this.#queue.filter((queued) => queued !== target); this.#queue.unshift(target); }
    });
    this.#sortQueue(); this.#drain(); return promise;
  }
  abortQueued(reason = "Scheduler closed"): void {
    this.#closed = true; const error = new TranslationError("aborted", reason);
    for (const job of [...this.#jobs.values()]) { job.controller.abort(reason); this.#finish(job, undefined, error); }
    this.#queue = []; this.#jobs.clear();
  }
  #finish(job: Job, text?: string, error?: unknown): void {
    if (job.settled) return;
    job.settled = true;
    for (const consumer of [...job.consumers]) {
      consumer.signal.removeEventListener("abort", consumer.abort);
      if (consumer.timer) clearTimeout(consumer.timer);
      if (error) consumer.reject(error); else consumer.resolve({ requestId: consumer.requestId, text: text! });
    }
    job.consumers.clear();
    if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    if (job.started) { job.started = false; this.#active = Math.max(0, this.#active - 1); }
    if (!this.#closed) { this.#sortQueue(); this.#drain(); }
  }
  #sortQueue(): void { this.#queue.sort((a, b) => (a.priority === "input" ? 0 : 1) - (b.priority === "input" ? 0 : 1)); }
  #drain(): void {
    while (!this.#closed && this.#active < this.maxConcurrency && this.#queue.length) {
      if (this.#queue[0]!.priority === "output" && this.#active >= this.maxConcurrency - this.reservedInputSlots) break;
      const job = this.#queue.shift()!; if (!job.consumers.size || job.settled) continue;
      job.started = true; this.#active++;
      const work = Promise.resolve().then(() => job.run(job.controller.signal));
      void work.then((text) => this.#finish(job, text), (error) => this.#finish(job, undefined, error));
    }
  }
}
