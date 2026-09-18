import { getAuthorizedClient } from "./google/auth.js";
import { deleteDraft } from "./google/gmail.js";
import { deleteEvent } from "./google/calendar.js";
import type { ActionRow } from "./actions.js";

interface UndoPayload {
  type: "delete_draft" | "delete_calendar_event";
  draftId?: string;
  calendarId?: string;
  providerId?: string;
}

/**
 * Called after a successful execution to record what would undo it.
 * Sending an email has no undo payload at all — there's no API call
 * that unsends a message, so gmail.send_draft's actions simply never get
 * one (undo unavailable is the honest answer, not a fabricated one).
 */
export function finalizeUndoPayload(tool: string, result: unknown): UndoPayload | null {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  if (!record) return null;

  if (tool === "gmail.create_draft" && typeof record.draftId === "string") {
    return { type: "delete_draft", draftId: record.draftId };
  }
  if (tool === "calendar.create_event" && typeof record.providerId === "string" && typeof record.calendarId === "string") {
    return { type: "delete_calendar_event", calendarId: record.calendarId, providerId: record.providerId };
  }
  return null;
}

export async function performUndo(action: ActionRow): Promise<void> {
  const payload = action.undoPayload as UndoPayload | null;
  if (!payload?.type) {
    throw new Error("No undo available for this action.");
  }

  const auth = await getAuthorizedClient();

  if (payload.type === "delete_draft" && payload.draftId) {
    await deleteDraft(auth, payload.draftId);
    return;
  }
  if (payload.type === "delete_calendar_event" && payload.calendarId && payload.providerId) {
    await deleteEvent(auth, payload.calendarId, payload.providerId);
    return;
  }
  throw new Error("Undo payload is incomplete.");
}
