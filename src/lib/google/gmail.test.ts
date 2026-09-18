import { describe, expect, it } from "vitest";
import { parseMessage } from "./gmail.js";
import type { gmail_v1 } from "googleapis";

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("parseMessage", () => {
  it("parses headers, plain-text body, and labels from a simple message", () => {
    const message: gmail_v1.Schema$Message = {
      id: "msg1",
      threadId: "thread1",
      snippet: "Hi there",
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Jane Recruiter <jane@example.com>" },
          { name: "To", value: "me@example.com, other@example.com" },
          { name: "Subject", value: "An opportunity for you" },
          { name: "Date", value: "Fri, 18 Sep 2026 10:00:00 +0000" },
        ],
        body: { data: encode("Hi there, full body text.") },
      },
    };

    const parsed = parseMessage(message);
    expect(parsed.messageId).toBe("msg1");
    expect(parsed.threadId).toBe("thread1");
    expect(parsed.fromAddress).toBe("jane@example.com");
    expect(parsed.fromName).toBe("Jane Recruiter");
    expect(parsed.toAddresses).toEqual(["me@example.com", "other@example.com"]);
    expect(parsed.subject).toBe("An opportunity for you");
    expect(parsed.bodyText).toBe("Hi there, full body text.");
    expect(parsed.labels).toEqual(["INBOX", "UNREAD"]);
    expect(parsed.receivedAt?.toISOString()).toBe(new Date("Fri, 18 Sep 2026 10:00:00 +0000").toISOString());
  });

  it("recursively finds the text/plain part in a multipart message", () => {
    const message: gmail_v1.Schema$Message = {
      id: "msg2",
      snippet: "snippet",
      payload: {
        mimeType: "multipart/alternative",
        headers: [{ name: "From", value: "no-name@example.com" }],
        parts: [
          { mimeType: "text/html", body: { data: encode("<p>html</p>") } },
          { mimeType: "text/plain", body: { data: encode("plain text body") } },
        ],
      },
    };

    const parsed = parseMessage(message);
    expect(parsed.bodyText).toBe("plain text body");
    expect(parsed.fromAddress).toBe("no-name@example.com");
    expect(parsed.fromName).toBeNull();
  });

  it("falls back to the snippet when no text/plain part exists", () => {
    const message: gmail_v1.Schema$Message = {
      id: "msg3",
      snippet: "just a snippet",
      payload: {
        mimeType: "text/html",
        headers: [],
        body: { data: encode("<p>html only</p>") },
      },
    };

    const parsed = parseMessage(message);
    expect(parsed.bodyText).toBe("just a snippet");
  });

  it("handles a From header with no display name", () => {
    const message: gmail_v1.Schema$Message = {
      id: "msg4",
      payload: { headers: [{ name: "From", value: "plain@example.com" }] },
    };
    const parsed = parseMessage(message);
    expect(parsed.fromAddress).toBe("plain@example.com");
    expect(parsed.fromName).toBeNull();
  });

  it("handles a missing From header without throwing", () => {
    const message: gmail_v1.Schema$Message = { id: "msg5", payload: { headers: [] } };
    const parsed = parseMessage(message);
    expect(parsed.fromAddress).toBeNull();
    expect(parsed.toAddresses).toEqual([]);
    expect(parsed.receivedAt).toBeNull();
  });

  it("decodes a quoted-printable text/plain body instead of leaving soft breaks and hex escapes", () => {
    // "LinkedIn sells to recruiters — talented people" with a
    // soft line break mid-word and an em dash encoded as =E2=80=94,
    // exactly as Gmail sends a quoted-printable plain-text part.
    const quotedPrintable = "LinkedIn se=\r\nlls to recruiters =E2=80=94 talented people";
    const message: gmail_v1.Schema$Message = {
      id: "msg6",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "Content-Transfer-Encoding", value: "quoted-printable" },
        ],
        body: { data: Buffer.from(quotedPrintable, "utf8").toString("base64url") },
      },
    };

    const parsed = parseMessage(message);
    expect(parsed.bodyText).toBe("LinkedIn sells to recruiters — talented people");
  });

  it("decodes quoted-printable text that also contains a literal unescaped multi-byte UTF-8 character", () => {
    // Some real senders mark a part quoted-printable but still emit a
    // raw multi-byte UTF-8 character (e.g. a bullet) instead of
    // escaping it — building the buffer directly (rather than via a
    // pre-decoded string) is what makes this not corrupt into U+FFFD.
    const buffer = Buffer.concat([
      Buffer.from("Hi there\r\n", "utf8"),
      Buffer.from("•", "utf8"), // literal bullet, not "=E2=80=A2"
      Buffer.from("\r\nMatt here=\r\n, co-founder", "utf8"),
    ]);
    const message: gmail_v1.Schema$Message = {
      id: "msg7",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Content-Transfer-Encoding", value: "quoted-printable" }],
        body: { data: buffer.toString("base64url") },
      },
    };

    const parsed = parseMessage(message);
    expect(parsed.bodyText).toBe("Hi there\r\n•\r\nMatt here, co-founder");
  });
});
