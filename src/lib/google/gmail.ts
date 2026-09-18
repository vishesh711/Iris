import { google, type gmail_v1 } from "googleapis";
import type { OAuthClient } from "./auth.js";

const REQUEST_OPTIONS = { timeout: 10_000 };

function getClient(auth: OAuthClient) {
  return google.gmail({ version: "v1", auth });
}

export interface ParsedEmail {
  messageId: string;
  threadId: string | null;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string[];
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  labels: string[];
  receivedAt: Date | null;
  raw: gmail_v1.Schema$Message;
}

function getHeader(message: gmail_v1.Schema$Message, name: string): string | null {
  const header = message.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value ?? null;
}

function parseFrom(fromHeader: string | null): { address: string | null; name: string | null } {
  if (!fromHeader) return { address: null, name: null };
  const match = /^(.*?)\s*<(.+)>$/.exec(fromHeader.trim());
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, "");
    return { address: match[2].trim(), name: name || null };
  }
  return { address: fromHeader.trim(), name: null };
}

function getPartHeader(part: gmail_v1.Schema$MessagePart, name: string): string | null {
  const header = part.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value ?? null;
}

/**
 * Gmail API's body.data is only base64url-transport-encoded — if the
 * original MIME part itself used Content-Transfer-Encoding:
 * quoted-printable (common for HTML-authored emails' plain-text
 * alternative), the decoded text still contains soft line breaks
 * ("=\r\n") and "=XX" hex-escaped bytes that need a second decode pass,
 * or downstream text (chunking, embeddings) ends up corrupted.
 */
function decodeQuotedPrintable(text: string): string {
  const withoutSoftBreaks = text.replace(/=\r\n/g, "").replace(/=\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const hex = withoutSoftBreaks.slice(i + 1, i + 3);
    if (withoutSoftBreaks[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(withoutSoftBreaks.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function extractPlainText(part: gmail_v1.Schema$MessagePart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) {
    const decoded = Buffer.from(part.body.data, "base64url").toString("utf8");
    const encoding = getPartHeader(part, "Content-Transfer-Encoding");
    return encoding?.toLowerCase() === "quoted-printable" ? decodeQuotedPrintable(decoded) : decoded;
  }
  for (const child of part.parts ?? []) {
    const text = extractPlainText(child);
    if (text) return text;
  }
  return null;
}

export function parseMessage(message: gmail_v1.Schema$Message): ParsedEmail {
  const { address, name } = parseFrom(getHeader(message, "From"));
  const toHeader = getHeader(message, "To");
  const dateHeader = getHeader(message, "Date");

  return {
    messageId: message.id ?? "",
    threadId: message.threadId ?? null,
    fromAddress: address,
    fromName: name,
    toAddresses: toHeader ? toHeader.split(",").map((s) => s.trim()) : [],
    subject: getHeader(message, "Subject"),
    snippet: message.snippet ?? null,
    bodyText: extractPlainText(message.payload) ?? message.snippet ?? null,
    labels: message.labelIds ?? [],
    receivedAt: dateHeader ? new Date(dateHeader) : null,
    raw: message,
  };
}

export async function getCurrentHistoryId(auth: OAuthClient): Promise<string> {
  const gmail = getClient(auth);
  const { data } = await gmail.users.getProfile({ userId: "me" }, REQUEST_OPTIONS);
  if (!data.historyId) {
    throw new Error("Gmail profile did not include a historyId");
  }
  return data.historyId;
}

export async function listInitialMessageIds(auth: OAuthClient, maxResults = 25): Promise<string[]> {
  const gmail = getClient(auth);
  const { data } = await gmail.users.messages.list({ userId: "me", maxResults }, REQUEST_OPTIONS);
  return (data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}

/**
 * Gmail's history API redelivers and can 404 if startHistoryId has
 * expired (Google doesn't guarantee history past ~1 week) — callers must
 * be ready to fall back to a full backfill on that specific error.
 */
export async function listMessageIdsSince(
  auth: OAuthClient,
  startHistoryId: string
): Promise<{ messageIds: string[]; historyId: string | null }> {
  const gmail = getClient(auth);
  const messageIds = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId: string | null = null;

  do {
    const { data } = await gmail.users.history.list(
      {
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        pageToken,
      },
      REQUEST_OPTIONS
    );

    for (const record of data.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        if (added.message?.id) messageIds.add(added.message.id);
      }
    }
    if (data.historyId) latestHistoryId = data.historyId;
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  return { messageIds: [...messageIds], historyId: latestHistoryId };
}

export async function getMessage(auth: OAuthClient, id: string): Promise<ParsedEmail> {
  const gmail = getClient(auth);
  const { data } = await gmail.users.messages.get({ userId: "me", id, format: "full" }, REQUEST_OPTIONS);
  return parseMessage(data);
}
