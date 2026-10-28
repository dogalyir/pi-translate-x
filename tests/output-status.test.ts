import { describe, expect, it } from "vitest";
import { OutputStatusTracker } from "../src/status.js";

describe("OutputStatusTracker", () => {
  it("keeps one generation visible until its last activity finishes", () => {
    const tracker = new OutputStatusTracker();
    const first = tracker.start(1);
    const second = tracker.start(1);
    expect(first.action).toBe("show");
    expect(second.action).toBe("none");
    expect(tracker.finish(first.token, 1)).toBe("none");
    expect(tracker.finish(second.token, 1)).toBe("clear");
  });

  it("ignores completions made stale by reset and a newer generation", () => {
    const tracker = new OutputStatusTracker();
    const old = tracker.start(1);
    expect(tracker.reset()).toBe("clear");
    const current = tracker.start(2);
    expect(tracker.finish(old.token, 1)).toBe("none");
    expect(tracker.finish(current.token, 2)).toBe("clear");
    expect(tracker.key).toBe("pi-translate-x:output");
    expect(tracker.text).toBe("Translating response…");
  });

  it("does not allow an older finish to clear a newer generation even without reset", () => {
    const tracker = new OutputStatusTracker();
    const old = tracker.start(1);
    const current = tracker.start(2);
    expect(old.action).toBe("show");
    expect(current.action).toBe("show");
    expect(tracker.finish(old.token, 1)).toBe("none");
    expect(tracker.finish(current.token, 2)).toBe("clear");
  });

  it("returns none on reset when no status is visible", () => {
    const tracker = new OutputStatusTracker();
    expect(tracker.reset()).toBe("none");
  });
});
