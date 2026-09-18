import { describe, expect, it } from "vitest";
import { extractKeywords } from "./retrieval.js";

describe("extractKeywords", () => {
  it("drops stopwords and short words from a natural-language question", () => {
    const words = extractKeywords(
      "Who was the recruiter that contacted me about the contract role, and what did I decide about the rate?"
    );
    expect(words).toEqual(expect.arrayContaining(["recruiter", "contacted", "contract", "role", "decide", "rate"]));
    expect(words).not.toEqual(expect.arrayContaining(["who", "was", "the", "that", "and", "what", "did", "about"]));
  });

  it("deduplicates repeated words", () => {
    expect(extractKeywords("rate rate RATE")).toEqual(["rate"]);
  });

  it("returns an empty list for a question made entirely of stopwords", () => {
    expect(extractKeywords("What did I do?")).toEqual([]);
  });
});
