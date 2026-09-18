import { describe, expect, it } from "vitest";
import { classifyGoogleError } from "./errors.js";

describe("classifyGoogleError", () => {
  it("classifies a 401 as auth", () => {
    expect(classifyGoogleError({ status: 401 })).toBe("auth");
  });

  it("classifies a 403 as auth", () => {
    expect(classifyGoogleError({ response: { status: 403 } })).toBe("auth");
  });

  it("classifies a 429 as rate_limit", () => {
    expect(classifyGoogleError({ code: 429 })).toBe("rate_limit");
  });

  it("classifies a 5xx as provider_failure", () => {
    expect(classifyGoogleError({ status: 503 })).toBe("provider_failure");
  });

  it("classifies a non-auth 4xx as invalid_input", () => {
    expect(classifyGoogleError({ status: 400 })).toBe("invalid_input");
  });

  it("classifies a network error code as retryable", () => {
    expect(classifyGoogleError({ code: "ECONNRESET" })).toBe("retryable");
    expect(classifyGoogleError({ code: "ETIMEDOUT" })).toBe("retryable");
  });

  it("classifies anything unrecognized as internal_failure rather than guessing", () => {
    expect(classifyGoogleError(new Error("something odd"))).toBe("internal_failure");
    expect(classifyGoogleError(null)).toBe("internal_failure");
    expect(classifyGoogleError("a plain string")).toBe("internal_failure");
  });

  it("prefers response.status when both status and response.status are present", () => {
    expect(classifyGoogleError({ status: 200, response: { status: 401 } })).toBe("auth");
  });
});
