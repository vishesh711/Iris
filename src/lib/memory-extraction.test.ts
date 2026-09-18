import { describe, expect, it, vi } from "vitest";

vi.mock("./ollama.js", () => ({
  ollamaGenerate: vi.fn(),
}));

import { ollamaGenerate } from "./ollama.js";
import { extractMemoryCandidate } from "./memory-extraction.js";

const mockGenerate = vi.mocked(ollamaGenerate);

describe("extractMemoryCandidate", () => {
  it("parses a well-formed candidate", async () => {
    mockGenerate.mockResolvedValueOnce(
      JSON.stringify({
        statement: "Prefers aisle seats on long flights.",
        subject: "user",
        predicate: "prefers",
        object: "aisle seat",
        decayClass: "preference",
      })
    );

    const candidate = await extractMemoryCandidate("I always try to get an aisle seat on long flights");
    expect(candidate).toEqual({
      statement: "Prefers aisle seats on long flights.",
      subject: "user",
      predicate: "prefers",
      object: "aisle seat",
      decayClass: "preference",
    });
  });

  it("returns null when the model says there is nothing to store", async () => {
    mockGenerate.mockResolvedValueOnce("null");
    expect(await extractMemoryCandidate("lol ok")).toBeNull();
  });

  it("returns null on malformed JSON rather than throwing", async () => {
    mockGenerate.mockResolvedValueOnce("not json at all");
    expect(await extractMemoryCandidate("whatever")).toBeNull();
  });

  it("returns null when statement is missing", async () => {
    mockGenerate.mockResolvedValueOnce(JSON.stringify({ subject: "user" }));
    expect(await extractMemoryCandidate("whatever")).toBeNull();
  });

  it("strips markdown code fences before parsing", async () => {
    mockGenerate.mockResolvedValueOnce(
      "```json\n" + JSON.stringify({ statement: "Lives in Philadelphia.", decayClass: "identity" }) + "\n```"
    );
    const candidate = await extractMemoryCandidate("I live in Philadelphia now");
    expect(candidate?.statement).toBe("Lives in Philadelphia.");
    expect(candidate?.decayClass).toBe("identity");
  });

  it("falls back to 'preference' for an invalid or missing decayClass", async () => {
    mockGenerate.mockResolvedValueOnce(JSON.stringify({ statement: "Something.", decayClass: "not-a-real-class" }));
    const candidate = await extractMemoryCandidate("whatever");
    expect(candidate?.decayClass).toBe("preference");
  });

  it("normalizes empty-string optional fields to null", async () => {
    mockGenerate.mockResolvedValueOnce(
      JSON.stringify({ statement: "Something.", subject: "", predicate: "", object: "", decayClass: "intent" })
    );
    const candidate = await extractMemoryCandidate("whatever");
    expect(candidate?.subject).toBeNull();
    expect(candidate?.predicate).toBeNull();
    expect(candidate?.object).toBeNull();
  });
});
