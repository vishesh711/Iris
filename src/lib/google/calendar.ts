import { google, type calendar_v3 } from "googleapis";
import type { OAuthClient } from "./auth.js";

const REQUEST_OPTIONS = { timeout: 10_000 };

function getClient(auth: OAuthClient) {
  return google.calendar({ version: "v3", auth });
}

export interface ParsedCalendarEvent {
  providerId: string;
  calendarId: string;
  title: string | null;
  description: string | null;
  location: string | null;
  startAt: Date | null;
  endAt: Date | null;
  allDay: boolean;
  attendees: string[];
  status: string | null;
  updatedAt: Date | null;
  raw: calendar_v3.Schema$Event;
}

function parseDateTime(dt: calendar_v3.Schema$EventDateTime | undefined): { date: Date | null; allDay: boolean } {
  if (!dt) return { date: null, allDay: false };
  if (dt.dateTime) return { date: new Date(dt.dateTime), allDay: false };
  if (dt.date) return { date: new Date(dt.date), allDay: true };
  return { date: null, allDay: false };
}

export function parseEvent(event: calendar_v3.Schema$Event, calendarId: string): ParsedCalendarEvent {
  const start = parseDateTime(event.start);
  const end = parseDateTime(event.end);

  return {
    providerId: event.id ?? "",
    calendarId,
    title: event.summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    startAt: start.date,
    endAt: end.date,
    allDay: start.allDay,
    attendees: (event.attendees ?? []).map((a) => a.email).filter((email): email is string => Boolean(email)),
    status: event.status ?? null,
    updatedAt: event.updated ? new Date(event.updated) : null,
    raw: event,
  };
}

/**
 * Full backfill, establishing a syncToken for future incremental polls.
 * timeMin is only valid on this initial listing — Google's API rejects
 * combining timeMin/timeMax with an incremental syncToken request.
 */
export async function listInitialEvents(
  auth: OAuthClient,
  calendarId = "primary"
): Promise<{ events: ParsedCalendarEvent[]; syncToken: string | null }> {
  const calendar = getClient(auth);
  const events: ParsedCalendarEvent[] = [];
  let pageToken: string | undefined;
  let syncToken: string | null = null;

  do {
    const { data } = await calendar.events.list(
      {
        calendarId,
        pageToken,
        singleEvents: true,
        timeMin: new Date().toISOString(),
        maxResults: 100,
      },
      REQUEST_OPTIONS
    );

    for (const event of data.items ?? []) {
      events.push(parseEvent(event, calendarId));
    }
    pageToken = data.nextPageToken ?? undefined;
    if (data.nextSyncToken) syncToken = data.nextSyncToken;
  } while (pageToken);

  return { events, syncToken };
}

/**
 * A syncToken can expire (Google returns 410 Gone) — callers must be
 * ready to fall back to listInitialEvents and re-establish a fresh token.
 */
export async function listEventsSince(
  auth: OAuthClient,
  calendarId: string,
  syncToken: string
): Promise<{ events: ParsedCalendarEvent[]; syncToken: string | null }> {
  const calendar = getClient(auth);
  const events: ParsedCalendarEvent[] = [];
  let pageToken: string | undefined;
  let newSyncToken: string | null = null;

  do {
    const { data } = await calendar.events.list({ calendarId, pageToken, syncToken }, REQUEST_OPTIONS);

    for (const event of data.items ?? []) {
      events.push(parseEvent(event, calendarId));
    }
    pageToken = data.nextPageToken ?? undefined;
    if (data.nextSyncToken) newSyncToken = data.nextSyncToken;
  } while (pageToken);

  return { events, syncToken: newSyncToken };
}
