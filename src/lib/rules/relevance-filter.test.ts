import { describe, expect, it, vi } from "vitest";

vi.mock("../ollama.js", () => ({
  ollamaGenerate: vi.fn(),
}));

import { ollamaGenerate } from "../ollama.js";
import { filterRelevantCandidates } from "./relevance-filter.js";
import type { RuleCandidate } from "./types.js";

const mockGenerate = vi.mocked(ollamaGenerate);

const candidates: RuleCandidate[] = [
  { entityId: "e1", dedupeKey: "e1", summary: "Recruiter A went quiet 5 days ago.", metadata: {} },
  { entityId: "e2", dedupeKey: "e2", summary: "Recruiter B went quiet yesterday.", metadata: {} },
];

describe("filterRelevantCandidates", () => {
  it("returns an empty array without calling the model when there are no candidates", async () => {
    const result = await filterRelevantCandidates("recruiter-follow-up", []);
    expect(result).toEqual([]);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("maps a selected index back to its candidate", async () => {
    mockGenerate.mockResolvedValueOnce(
      JSON.stringify({ selected: [{ index: 1, title: "Follow up", body: "It has been a while." }] })
    );

    const result = await filterRelevantCandidates("recruiter-follow-up", candidates);
    expect(result).toEqual([{ candidate: candidates[0], title: "Follow up", body: "It has been a while." }]);
  });

  it("caps selections at 3 even if the model returns more", async () => {
    mockGenerate.mockResolvedValueOnce(
      JSON.stringify({
        selected: [
          { index: 1, title: "a", body: "a" },
          { index: 2, title: "b", body: "b" },
          { index: 1, title: "c", body: "c" },
          { index: 2, title: "d", body: "d" },
        ],
      })
    );

    const result = await filterRelevantCandidates("recruiter-follow-up", candidates);
    expect(result).toHaveLength(3);
  });

  it("returns an empty array when the model selects nothing", async () => {
    mockGenerate.mockResolvedValueOnce(JSON.stringify({ selected: [] }));
    expect(await filterRelevantCandidates("recruiter-follow-up", candidates)).toEqual([]);
  });

  it("returns an empty array on malformed JSON rather than throwing", async () => {
    mockGenerate.mockResolvedValueOnce("not json");
    expect(await filterRelevantCandidates("recruiter-follow-up", candidates)).toEqual([]);
  });

  it("ignores a selection whose index is out of range", async () => {
    mockGenerate.mockResolvedValueOnce(JSON.stringify({ selected: [{ index: 99, title: "x", body: "y" }] }));
    expect(await filterRelevantCandidates("recruiter-follow-up", candidates)).toEqual([]);
  });
});
