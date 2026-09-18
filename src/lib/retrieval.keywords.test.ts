import { describe, expect, it } from "vitest";
import { countKeywordMatches, extractKeywords } from "./retrieval.js";

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

describe("countKeywordMatches", () => {
  it("counts how many distinct keywords appear in the text, case-insensitively", () => {
    const keywords = ["recruiter", "contract", "rate"];
    expect(countKeywordMatches("Confirming your CONTRACT rate for the role", keywords)).toBe(2);
  });

  it("ranks a highly-relevant older item above a barely-relevant newer one", () => {
    const keywords = ["newtonx", "rate", "contract"];
    const relevantButOlder = countKeywordMatches("NewtonX contract rate confirmation", keywords);
    const recentButGeneric = countKeywordMatches("Thanks for applying to our contract role", keywords);
    expect(relevantButOlder).toBeGreaterThan(recentButGeneric);
  });

  it("returns 0 when no keywords match", () => {
    expect(countKeywordMatches("completely unrelated text", ["recruiter", "rate"])).toBe(0);
  });
});
