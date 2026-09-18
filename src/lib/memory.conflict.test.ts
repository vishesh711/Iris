import { describe, expect, it, vi } from "vitest";

vi.mock("./ollama.js", () => ({
  ollamaGenerate: vi.fn(),
}));

import { ollamaGenerate } from "./ollama.js";
import { checkConflict } from "./memory.js";

const mockGenerate = vi.mocked(ollamaGenerate);

describe("checkConflict", () => {
  it("skips the model call entirely when there are no existing statements", async () => {
    const result = await checkConflict("Lives in Philadelphia.", []);
    expect(result).toEqual({ relationship: "independent", contradictedIndex: null });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("parses a contradicts response with a valid index", async () => {
    mockGenerate.mockResolvedValueOnce(JSON.stringify({ relationship: "contradicts", contradictedIndex: 1 }));
    const result = await checkConflict("Lives in Philadelphia now.", ["Lives in Boston.", "Lives in NYC."]);
    expect(result).toEqual({ relationship: "contradicts", contradictedIndex: 1 });
  });

  it("parses an extends response and ignores any contradictedIndex on it", async () => {
    mockGenerate.mockResolvedValueOnce(JSON.stringify({ relationship: "extends", contradictedIndex: 0 }));
    const result = await checkConflict("Prefers window seats on short flights specifically.", ["Prefers window seats."]);
    expect(result).toEqual({ relationship: "extends", contradictedIndex: null });
  });

  it("falls back to independent on malformed JSON", async () => {
    mockGenerate.mockResolvedValueOnce("not json");
    const result = await checkConflict("Something new.", ["Something old."]);
    expect(result).toEqual({ relationship: "independent", contradictedIndex: null });
  });

  it("falls back to independent on an unrecognized relationship value", async () => {
    mockGenerate.mockResolvedValueOnce(JSON.stringify({ relationship: "maybe", contradictedIndex: null }));
    const result = await checkConflict("Something new.", ["Something old."]);
    expect(result).toEqual({ relationship: "independent", contradictedIndex: null });
  });

  it("nulls out an out-of-range contradictedIndex rather than trusting it", async () => {
    mockGenerate.mockResolvedValueOnce(JSON.stringify({ relationship: "contradicts", contradictedIndex: 99 }));
    const result = await checkConflict("Something new.", ["Only one existing statement."]);
    expect(result).toEqual({ relationship: "contradicts", contradictedIndex: null });
  });
});
