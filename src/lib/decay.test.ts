import { describe, expect, it } from "vitest";
import { decayWeight } from "./decay.js";

describe("decayWeight", () => {
  it("never decays identity facts, however old", () => {
    const weight = decayWeight({
      decayClass: "identity",
      lastConfirmedAt: new Date("2000-01-01"),
      now: new Date("2026-01-01"),
    });
    expect(weight).toBe(1);
  });

  it("keeps scheduled facts at full weight until valid_until, then zero", () => {
    const validUntil = new Date("2026-01-10T00:00:00Z");
    const before = decayWeight({
      decayClass: "scheduled",
      lastConfirmedAt: new Date("2026-01-01"),
      now: new Date("2026-01-09T00:00:00Z"),
      validUntil,
    });
    const after = decayWeight({
      decayClass: "scheduled",
      lastConfirmedAt: new Date("2026-01-01"),
      now: new Date("2026-01-11T00:00:00Z"),
      validUntil,
    });
    expect(before).toBe(1);
    expect(after).toBe(0);
  });

  it("treats a scheduled fact with no valid_until as always current", () => {
    const weight = decayWeight({
      decayClass: "scheduled",
      lastConfirmedAt: new Date("2000-01-01"),
      now: new Date("2026-01-01"),
      validUntil: null,
    });
    expect(weight).toBe(1);
  });

  it("decays preference, employment, and intent monotonically with age", () => {
    for (const decayClass of ["preference", "employment", "intent"] as const) {
      const lastConfirmedAt = new Date("2026-01-01T00:00:00Z");
      const early = decayWeight({ decayClass, lastConfirmedAt, now: new Date("2026-01-02T00:00:00Z") });
      const late = decayWeight({ decayClass, lastConfirmedAt, now: new Date("2027-01-01T00:00:00Z") });
      expect(early).toBeGreaterThan(late);
      expect(early).toBeLessThanOrEqual(1);
      expect(late).toBeGreaterThan(0);
    }
  });

  it("decays intent faster than preference, and preference faster than employment, at the same age", () => {
    const lastConfirmedAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-11T00:00:00Z"); // 10 days later
    const intent = decayWeight({ decayClass: "intent", lastConfirmedAt, now });
    const preference = decayWeight({ decayClass: "preference", lastConfirmedAt, now });
    const employment = decayWeight({ decayClass: "employment", lastConfirmedAt, now });
    expect(intent).toBeLessThan(preference);
    expect(preference).toBeLessThan(employment);
  });

  it("reinforcement slows decay: a higher reinforcement count yields a higher weight at the same age", () => {
    const lastConfirmedAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-08T00:00:00Z");
    const once = decayWeight({ decayClass: "intent", lastConfirmedAt, now, reinforcementCount: 1 });
    const reinforced = decayWeight({ decayClass: "intent", lastConfirmedAt, now, reinforcementCount: 5 });
    expect(reinforced).toBeGreaterThan(once);
  });

  it("never returns a weight above 1 or below 0 for smoothly-decaying classes", () => {
    const lastConfirmedAt = new Date("2026-01-01T00:00:00Z");
    for (const now of [new Date("2026-01-01T00:00:00Z"), new Date("2100-01-01T00:00:00Z")]) {
      const weight = decayWeight({ decayClass: "preference", lastConfirmedAt, now });
      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThanOrEqual(1);
    }
  });
});
