import { describe, expect, it } from "vitest";
import { parseEvent } from "./calendar.js";
import type { calendar_v3 } from "googleapis";

describe("parseEvent", () => {
  it("parses a timed event", () => {
    const event: calendar_v3.Schema$Event = {
      id: "evt1",
      summary: "1:1 with manager",
      description: "Weekly sync",
      location: "Zoom",
      start: { dateTime: "2026-09-20T15:00:00Z" },
      end: { dateTime: "2026-09-20T15:30:00Z" },
      attendees: [{ email: "me@example.com" }, { email: "manager@example.com" }],
      status: "confirmed",
      updated: "2026-09-18T10:00:00Z",
    };

    const parsed = parseEvent(event, "primary");
    expect(parsed.providerId).toBe("evt1");
    expect(parsed.calendarId).toBe("primary");
    expect(parsed.title).toBe("1:1 with manager");
    expect(parsed.allDay).toBe(false);
    expect(parsed.startAt?.toISOString()).toBe("2026-09-20T15:00:00.000Z");
    expect(parsed.endAt?.toISOString()).toBe("2026-09-20T15:30:00.000Z");
    expect(parsed.attendees).toEqual(["me@example.com", "manager@example.com"]);
    expect(parsed.status).toBe("confirmed");
  });

  it("parses an all-day event using the date field, not dateTime", () => {
    const event: calendar_v3.Schema$Event = {
      id: "evt2",
      summary: "Company holiday",
      start: { date: "2026-12-25" },
      end: { date: "2026-12-26" },
    };

    const parsed = parseEvent(event, "primary");
    expect(parsed.allDay).toBe(true);
    expect(parsed.startAt?.toISOString().startsWith("2026-12-25")).toBe(true);
  });

  it("handles an event with no attendees or description", () => {
    const event: calendar_v3.Schema$Event = {
      id: "evt3",
      summary: "Solo focus block",
      start: { dateTime: "2026-09-21T09:00:00Z" },
      end: { dateTime: "2026-09-21T10:00:00Z" },
    };

    const parsed = parseEvent(event, "work-calendar");
    expect(parsed.attendees).toEqual([]);
    expect(parsed.description).toBeNull();
    expect(parsed.calendarId).toBe("work-calendar");
  });

  it("handles a missing start/end without throwing", () => {
    const event: calendar_v3.Schema$Event = { id: "evt4", summary: "Weird event" };
    const parsed = parseEvent(event, "primary");
    expect(parsed.startAt).toBeNull();
    expect(parsed.endAt).toBeNull();
    expect(parsed.allDay).toBe(false);
  });
});
