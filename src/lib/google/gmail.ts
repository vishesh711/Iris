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
 * alternative), the underlying bytes still contain soft line breaks
 * ("=\r\n") and "=XX" hex-escaped bytes that need a second decode pass.
 * Operates on the raw byte buffer, not a pre-decoded UTF-8 string:
 * some real-world senders emit literal multi-byte UTF-8 characters
 * (e.g. an em dash) without escaping them even though the part claims
 * quoted-printable — decoding to a string first and then reading
 * charCodeAt() per character would truncate those to a single byte and
 * corrupt them into replacement characters.
 */
function decodeQuotedPrintable(buffer: Buffer): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x3d /* "=" */) {
      if (buffer[i + 1] === 0x0d && buffer[i + 2] === 0x0a) {
        i += 2; // soft line break "=\r\n" — join with next line
        continue;
      }
      if (buffer[i + 1] === 0x0a) {
        i += 1; // soft line break "=\n"
        continue;
      }
      const hex = String.fromCharCode(buffer[i + 1] ?? 0, buffer[i + 2] ?? 0);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(buffer[i]);
  }
  return Buffer.from(bytes);
}

function extractPlainText(part: gmail_v1.Schema$MessagePart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) {
    const raw = Buffer.from(part.body.data, "base64url");
    const encoding = getPartHeader(part, "Content-Transfer-Encoding");
    const decoded = encoding?.toLowerCase() === "quoted-printable" ? decodeQuotedPrintable(raw) : raw;
    return decoded.toString("utf8");
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

export interface DraftResult {
  draftId: string;
  messageId: string;
  threadId: string;
  recipient: string | null;
}

function buildReplyMime(params: { to: string; subject: string; body: string; inReplyTo?: string }): string {
  const headers = [`To: ${params.to}`, `Subject: ${params.subject}`, `Content-Type: text/plain; charset="UTF-8"`, `MIME-Version: 1.0`];
  if (params.inReplyTo) {
    headers.push(`In-Reply-To: ${params.inReplyTo}`, `References: ${params.inReplyTo}`);
  }
  const mime = `${headers.join("\r\n")}\r\n\r\n${params.body}`;
  return Buffer.from(mime, "utf8").toString("base64url");
}

/**
 * Deliberately scoped to replying within an existing thread, not
 * composing to an arbitrary new address — the recipient is always
 * someone who already emailed the person, which is what makes the
 * contacts allowlist a meaningful check later at send time.
 */
export async function createDraftReply(auth: OAuthClient, threadId: string, body: string): Promise<DraftResult> {
  const gmail = getClient(auth);
  const { data: thread } = await gmail.users.threads.get(
    { userId: "me", id: threadId, format: "metadata", metadataHeaders: ["From", "Subject", "Message-ID"] },
    REQUEST_OPTIONS
  );

  const messages = thread.messages ?? [];
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) {
    throw new Error(`Thread ${threadId} has no messages to reply to`);
  }

  const fromHeader = lastMessage.payload?.headers?.find((h) => h.name?.toLowerCase() === "from")?.value ?? null;
  const { address: replyTo } = parseFrom(fromHeader);
  if (!replyTo) {
    throw new Error(`Could not determine a reply-to address for thread ${threadId}`);
  }

  const subjectHeader = lastMessage.payload?.headers?.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
  const subject = subjectHeader.toLowerCase().startsWith("re:") ? subjectHeader : `Re: ${subjectHeader}`;
  const messageIdHeader = lastMessage.payload?.headers?.find((h) => h.name?.toLowerCase() === "message-id")?.value ?? undefined;

  const raw = buildReplyMime({ to: replyTo, subject, body, inReplyTo: messageIdHeader });

  const { data } = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw, threadId } } }, REQUEST_OPTIONS);
  if (!data.id || !data.message?.id) {
    throw new Error("Gmail did not return a draft id");
  }

  return { draftId: data.id, messageId: data.message.id, threadId: data.message.threadId ?? threadId, recipient: replyTo };
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: number }).code === 404;
}

/** Returns null (not a throw) when the draft doesn't exist — used both for a normal not-found and for detecting an already-sent draft during crash reconciliation. */
export async function getDraft(auth: OAuthClient, draftId: string): Promise<gmail_v1.Schema$Draft | null> {
  const gmail = getClient(auth);
  try {
    const { data } = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "metadata" }, REQUEST_OPTIONS);
    return data;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

export function getDraftRecipient(draft: gmail_v1.Schema$Draft): string | null {
  const toHeader = draft.message?.payload?.headers?.find((h) => h.name?.toLowerCase() === "to")?.value ?? null;
  return parseFrom(toHeader).address;
}

export async function sendDraft(auth: OAuthClient, draftId: string): Promise<{ messageId: string }> {
  const gmail = getClient(auth);
  const { data } = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } }, REQUEST_OPTIONS);
  if (!data.id) {
    throw new Error("Gmail did not return a message id after sending");
  }
  return { messageId: data.id };
}

export async function deleteDraft(auth: OAuthClient, draftId: string): Promise<void> {
  const gmail = getClient(auth);
  await gmail.users.drafts.delete({ userId: "me", id: draftId }, REQUEST_OPTIONS);
}
