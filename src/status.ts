/** Internal, non-exported helper for the response-translation footer status. */
export type StatusAction = "show" | "clear" | "none";

/**
 * Tracks pending response-translation activities per lifecycle generation.
 *
 * The extension keeps exactly one footer key visible while any current
 * generation has pending translation work. A stale `finish` from an older
 * generation (or an already-reset generation) is ignored instead of clearing
 * a newer generation's indicator.
 */
export class OutputStatusTracker {
  readonly key = "pi-translate-x:output";
  readonly text = "Translating response…";

  #activities = new Map<number, number>();
  #nextToken = 1;
  #visibleGeneration: number | undefined;

  start(generation: number): { token: number; action: StatusAction } {
    const token = this.#nextToken++;
    this.#activities.set(token, generation);
    this.#dropStale(generation);
    if (this.#visibleGeneration !== generation) {
      this.#visibleGeneration = generation;
      return { token, action: "show" };
    }
    return { token, action: "none" };
  }

  finish(token: number, generation: number): StatusAction {
    if (!this.#activities.delete(token)) return "none";
    if (this.#visibleGeneration === generation && !this.#hasActive(generation)) {
      this.#visibleGeneration = undefined;
      return "clear";
    }
    return "none";
  }

  reset(): StatusAction {
    this.#activities.clear();
    if (this.#visibleGeneration !== undefined) {
      this.#visibleGeneration = undefined;
      return "clear";
    }
    return "none";
  }

  #dropStale(generation: number): void {
    for (const [token, activityGeneration] of this.#activities) {
      if (activityGeneration < generation) this.#activities.delete(token);
    }
  }

  #hasActive(generation: number): boolean {
    for (const activityGeneration of this.#activities.values()) {
      if (activityGeneration === generation) return true;
    }
    return false;
  }
}
