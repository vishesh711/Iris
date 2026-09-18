import { describe, expect, it } from "vitest";
import { deriveIdempotencyKey } from "./idempotency.js";

describe("deriveIdempotencyKey", () => {
  it("is deterministic for the same tool and arguments", () => {
    const a = deriveIdempotencyKey("memory.forget", { target: "Bob", matchedIds: ["1", "2"] });
    const b = deriveIdempotencyKey("memory.forget", { target: "Bob", matchedIds: ["1", "2"] });
    expect(a).toBe(b);
  });

  it("is independent of key insertion order", () => {
    const a = deriveIdempotencyKey("memory.forget", { target: "Bob", matchedIds: ["1", "2"] });
    const b = deriveIdempotencyKey("memory.forget", { matchedIds: ["1", "2"], target: "Bob" });
    expect(a).toBe(b);
  });

  it("differs when the tool differs", () => {
    const a = deriveIdempotencyKey("memory.forget", { target: "Bob" });
    const b = deriveIdempotencyKey("memory.remember", { target: "Bob" });
    expect(a).not.toBe(b);
  });

  it("differs when the arguments differ", () => {
    const a = deriveIdempotencyKey("memory.forget", { target: "Bob" });
    const b = deriveIdempotencyKey("memory.forget", { target: "Alice" });
    expect(a).not.toBe(b);
  });

  it("differs for nested argument differences, not just top-level ones", () => {
    const a = deriveIdempotencyKey("memory.forget", { target: "Bob", matchedIds: ["1", "2"] });
    const b = deriveIdempotencyKey("memory.forget", { target: "Bob", matchedIds: ["1", "3"] });
    expect(a).not.toBe(b);
  });
});
