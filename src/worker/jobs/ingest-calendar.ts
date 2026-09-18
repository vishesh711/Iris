import { db } from "../../db/client.js";
import { calendarEvents } from "../../db/schema.js";
import { recordEvent } from "../../lib/events.js";
import { getAuthorizedClient } from "../../lib/google/auth.js";
import { classifyGoogleError, extractHttpStatus } from "../../lib/google/errors.js";
import { listEventsSince, listInitialEvents, type ParsedCalendarEvent } from "../../lib/google/calendar.js";
import { notifyOwner } from "../../lib/notify.js";
import { getSyncState, recordSyncFailure, recordSyncSuccess, resetSyncState } from "../../lib/sync-state.js";

const SYNC_KEY = "calendar_sync_token";
const CALENDAR_ID = "primary";

interface CalendarSyncValue {
  syncToken?: string;
}

export async function runIngestCalendarJob(): Promise<void> {
  let auth;
  try {
    auth = await getAuthorizedClient();
  } catch (err) {
    console.error("Calendar ingest skipped:", err instanceof Error ? err.message : err);
    return;
  }

  const state = await getSyncState(SYNC_KEY);
  const storedSyncToken = (state?.value as CalendarSyncValue | null)?.syncToken;

  let events: ParsedCalendarEvent[];
  let newSyncToken: string | null;

  try {
    if (storedSyncToken) {
      const result = await listEventsSince(auth, CALENDAR_ID, storedSyncToken);
      events = result.events;
      newSyncToken = result.syncToken ?? storedSyncToken;
    } else {
      const result = await listInitialEvents(auth, CALENDAR_ID);
      events = result.events;
      newSyncToken = result.syncToken;
    }
  } catch (err) {
    await handleIngestError(err, storedSyncToken);
    return;
  }

  for (const event of events) {
    try {
      await ingestOneEvent(event);
    } catch (err) {
      console.error(`Calendar ingest: failed to process event ${event.providerId}`, err);
    }
  }

  if (newSyncToken) {
    await recordSyncSuccess(SYNC_KEY, { syncToken: newSyncToken } satisfies CalendarSyncValue);
  }
}

async function ingestOneEvent(event: ParsedCalendarEvent): Promise<void> {
  const [row] = await db
    .insert(calendarEvents)
    .values({
      providerId: event.providerId,
      calendarId: event.calendarId,
      title: event.title,
      description: event.description,
      location: event.location,
      startAt: event.startAt,
      endAt: event.endAt,
      allDay: event.allDay,
      attendees: event.attendees,
      status: event.status,
      updatedAt: event.updatedAt,
      raw: event.raw,
    })
    .onConflictDoUpdate({
      target: calendarEvents.providerId,
      set: {
        title: event.title,
        description: event.description,
        location: event.location,
        startAt: event.startAt,
        endAt: event.endAt,
        allDay: event.allDay,
        attendees: event.attendees,
        status: event.status,
        updatedAt: event.updatedAt,
        raw: event.raw,
      },
    })
    .returning();

  await recordEvent({
    source: "calendar",
    type: "calendar_event",
    rawData: { providerId: event.providerId, title: event.title, startAt: event.startAt },
    metadata: { untrusted: true, calendarEventId: row.id },
  });
}

async function handleIngestError(err: unknown, hadStoredSyncToken: string | undefined): Promise<void> {
  const failureClass = classifyGoogleError(err);
  const message = err instanceof Error ? err.message : String(err);
  const status = extractHttpStatus(err);

  // Google returns 410 Gone for an expired syncToken — clear it so the
  // next run falls back to a full backfill instead of retrying forever.
  if (status === 410 && hadStoredSyncToken) {
    await resetSyncState(SYNC_KEY, `syncToken expired, will re-backfill: ${message}`);
    return;
  }

  const alreadyFailing = Boolean((await getSyncState(SYNC_KEY))?.lastError);
  await recordSyncFailure(SYNC_KEY, message);

  if (failureClass === "auth" && !alreadyFailing) {
    await notifyOwner(`⚠️ Iris lost access to Calendar (auth error). Run \`npm run google:auth-setup\` again.\n\n${message}`);
  }
}
