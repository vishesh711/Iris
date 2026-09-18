import { describe, expect, it, vi } from "vitest";

vi.mock("./events.js", () => ({
  getEvent: vi.fn(),
}));

import { getEvent } from "./events.js";
import { isLineageUntrusted } from "./untrusted-lineage.js";

const mockGetEvent = vi.mocked(getEvent);

function event(id: string, metadata: Record<string, unknown> | null) {
  return { id, metadata } as Awaited<ReturnType<typeof getEvent>>;
}

describe("isLineageUntrusted", () => {
  it("is false for an event with no untrusted flag and no ancestor", async () => {
    mockGetEvent.mockResolvedValueOnce(event("e1", { label: "fact" }));
    expect(await isLineageUntrusted("e1")).toBe(false);
  });

  it("is true when the event itself is tagged untrusted", async () => {
    mockGetEvent.mockResolvedValueOnce(event("e1", { untrusted: true }));
    expect(await isLineageUntrusted("e1")).toBe(true);
  });

  it("walks back to an untrusted ancestor two hops away", async () => {
    mockGetEvent
      .mockResolvedValueOnce(event("e3", { sourceEventId: "e2" }))
      .mockResolvedValueOnce(event("e2", { sourceEventId: "e1" }))
      .mockResolvedValueOnce(event("e1", { untrusted: true }));
    expect(await isLineageUntrusted("e3")).toBe(true);
  });

  it("stops and returns false once the chain runs out", async () => {
    mockGetEvent
      .mockResolvedValueOnce(event("e2", { sourceEventId: "e1" }))
      .mockResolvedValueOnce(event("e1", { label: "fact" }));
    expect(await isLineageUntrusted("e2")).toBe(false);
  });

  it("returns false without throwing when the event doesn't exist", async () => {
    mockGetEvent.mockResolvedValueOnce(undefined as unknown as Awaited<ReturnType<typeof getEvent>>);
    expect(await isLineageUntrusted("missing")).toBe(false);
  });

  it("does not loop forever on a cyclic chain", async () => {
    mockGetEvent.mockImplementation(async (id: string) =>
      id === "a" ? event("a", { sourceEventId: "b" }) : event("b", { sourceEventId: "a" })
    );
    await expect(isLineageUntrusted("a")).resolves.toBe(false);
  });
});
