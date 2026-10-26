export class Lifecycle {
  #generation = 0; #controller = new AbortController(); #closed = false; #identity = "uninitialized";
  snapshot(): { generation: number; identity: string; signal: AbortSignal } { if (this.#closed) throw new Error("Lifecycle is closed"); return { generation: this.#generation, identity: this.#identity, signal: this.#controller.signal }; }
  activate(identity: string): void { if (this.#identity !== identity) { this.invalidate("Session identity changed"); this.#identity = identity; } }
  isCurrent(generation: number, identity = this.#identity): boolean { return !this.#closed && generation === this.#generation && identity === this.#identity; }
  invalidate(reason = "Lifecycle changed"): void { if (!this.#closed) { this.#generation++; this.#controller.abort(reason); this.#controller = new AbortController(); } }
  close(reason = "Lifecycle closed"): void { if (!this.#closed) { this.invalidate(reason); this.#closed = true; } }
  currentGeneration(): number { return this.#generation; }
}
