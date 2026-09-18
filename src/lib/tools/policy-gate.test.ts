import { describe, expect, it } from "vitest";
import { evaluateAction } from "./policy-gate.js";

// This is the highest-value test file in the repository. A regression here
// is the one class of bug able to do real damage: the model executing a
// side-effecting action it was never granted permission for.
describe("policy gate", () => {
  it("does not auto-approve a tier-2 tool: memory.forget must be queued for a tap", () => {
    expect(evaluateAction({ tool: "memory.forget" })).toBe("queued");
  });

  it("auto-approves a tier-0 read tool: memory.search", () => {
    expect(evaluateAction({ tool: "memory.search" })).toBe("approved");
  });

  it("auto-approves a tier-1 write tool: memory.remember", () => {
    expect(evaluateAction({ tool: "memory.remember" })).toBe("approved");
  });

  it("fails closed — denies rather than approving — when the tool is not in the registry", () => {
    expect(evaluateAction({ tool: "gmail.send_draft" })).toBe("denied");
    expect(evaluateAction({ tool: "totally.unregistered.tool" })).toBe("denied");
  });

  it("forces the queue for a tier-0 tool carrying untrusted lineage", () => {
    expect(evaluateAction({ tool: "memory.search", untrusted: true })).toBe("queued");
  });

  it("forces the queue for a tier-1 tool carrying untrusted lineage", () => {
    expect(evaluateAction({ tool: "memory.remember", untrusted: true })).toBe("queued");
  });

  it("never returns 'approved' for an unregistered tool even when untrusted is explicitly false", () => {
    expect(evaluateAction({ tool: "not.a.real.tool", untrusted: false })).toBe("denied");
  });

  it("kill switch drains every decision to queued, even a normally auto-approved tier-0 tool", () => {
    const original = process.env.IRIS_KILL_SWITCH;
    process.env.IRIS_KILL_SWITCH = "true";
    try {
      expect(evaluateAction({ tool: "memory.search" })).toBe("queued");
      expect(evaluateAction({ tool: "memory.remember" })).toBe("queued");
    } finally {
      process.env.IRIS_KILL_SWITCH = original;
    }
  });

  it("kill switch does not make an unregistered tool look approved", () => {
    const original = process.env.IRIS_KILL_SWITCH;
    process.env.IRIS_KILL_SWITCH = "true";
    try {
      // The kill switch returns before the registry lookup, so this is
      // "queued" rather than "denied" while active - documenting that
      // explicitly, since it's a real, deliberate short-circuit, not an
      // accident of ordering.
      expect(evaluateAction({ tool: "not.a.real.tool" })).toBe("queued");
    } finally {
      process.env.IRIS_KILL_SWITCH = original;
    }
  });
});
