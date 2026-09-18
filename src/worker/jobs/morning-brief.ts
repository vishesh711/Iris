import { and, gte, lt } from "drizzle-orm";
import { topicThreadId } from "../../bot/topics.js";
import { db } from "../../db/client.js";
import { calendarEvents } from "../../db/schema.js";
import { listActiveNudges } from "../../lib/nudges.js";
import { notifyOwner } from "../../lib/notify.js";

/**
 * Scheduled morning post: today's calendar events plus any still-open
 * nudges. Sends nothing on a genuinely quiet day (invariant 9 - silence
 * is a valid success, never force a message just to prove liveness).
 */
export async function runMorningBriefJob(): Promise<void> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);

  const [todaysEvents, activeNudges] = await Promise.all([
    db.select().from(calendarEvents).where(and(gte(calendarEvents.startAt, startOfDay), lt(calendarEvents.startAt, endOfDay))),
    listActiveNudges(),
  ]);

  if (todaysEvents.length === 0 && activeNudges.length === 0) {
    return;
  }

  const lines: string[] = ["Good morning."];

  if (todaysEvents.length > 0) {
    lines.push("", "Today:");
    for (const event of todaysEvents) {
      const time = event.startAt
        ? new Date(event.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "no time";
      lines.push(`- ${time} ${event.title ?? "(untitled)"}`);
    }
  }

  if (activeNudges.length > 0) {
    lines.push("", "Open items:");
    for (const nudge of activeNudges) {
      lines.push(`- ${nudge.title}`);
    }
  }

  await notifyOwner(lines.join("\n"), topicThreadId("brief"));
}
