import { describe, expect, it } from "vitest";
import { chunkText } from "./embeddings.js";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
  });

  it("returns an empty array for empty or whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("trims the input before chunking", () => {
    expect(chunkText("  hello world  ")).toEqual(["hello world"]);
  });

  it("splits long text into multiple chunks not exceeding maxChars", () => {
    const text = "a".repeat(50);
    const chunks = chunkText(text, 20);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("produces exactly one chunk when text length equals maxChars", () => {
    const text = "a".repeat(20);
    expect(chunkText(text, 20)).toEqual([text]);
  });
});
