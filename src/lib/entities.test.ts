import { describe, expect, it } from "vitest";
import { classifySenderType } from "./entities.js";

describe("classifySenderType", () => {
  it("classifies a known ATS domain as recruiter", () => {
    expect(
      classifySenderType({
        fromAddress: "noreply@mail.greenhouse.io",
        fromName: "Acme Corp",
        subject: "Your application",
        snippet: "Thanks for applying",
      })
    ).toBe("recruiter");
  });

  it("classifies by keyword in the name or subject when the domain is generic", () => {
    expect(
      classifySenderType({
        fromAddress: "jane@gmail.com",
        fromName: "Jane Doe, Technical Recruiter",
        subject: "Quick chat?",
        snippet: null,
      })
    ).toBe("recruiter");
  });

  it("classifies by a keyword phrase in the snippet", () => {
    expect(
      classifySenderType({
        fromAddress: "someone@example.com",
        fromName: "Someone",
        subject: "Hi",
        snippet: "I'm reaching out because I sourced you for an opportunity at a great startup.",
      })
    ).toBe("recruiter");
  });

  it("classifies an unrelated sender as unknown", () => {
    expect(
      classifySenderType({
        fromAddress: "mom@example.com",
        fromName: "Mom",
        subject: "Dinner Sunday?",
        snippet: "Are you free this Sunday?",
      })
    ).toBe("unknown");
  });

  it("handles all-null optional fields without throwing", () => {
    expect(
      classifySenderType({ fromAddress: "x@example.com", fromName: null, subject: null, snippet: null })
    ).toBe("unknown");
  });
});
