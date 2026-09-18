import { createEvent } from "../google/calendar.js";
import { getAuthorizedClient } from "../google/auth.js";

export async function handleCreateCalendarEvent(args: Record<string, unknown>): Promise<unknown> {
  const { title, description, location, startAt, endAt, calendarId } = args as {
    title: string;
    description?: string;
    location?: string;
    startAt: string;
    endAt: string;
    calendarId?: string;
  };
  if (!title || !startAt || !endAt) {
    throw new Error("calendar.create_event requires title, startAt, and endAt");
  }

  const auth = await getAuthorizedClient();
  const event = await createEvent(auth, {
    calendarId,
    title,
    description,
    location,
    startAt: new Date(startAt),
    endAt: new Date(endAt),
  });

  return { providerId: event.providerId, calendarId: event.calendarId, title: event.title, startAt: event.startAt };
}
