import { isAllowedRecipient } from "../contacts-allowlist.js";
import { getAuthorizedClient } from "../google/auth.js";
import { createDraftReply, getDraft, getDraftRecipient, sendDraft } from "../google/gmail.js";

export async function handleCreateDraft(args: Record<string, unknown>): Promise<unknown> {
  const { threadId, body } = args as { threadId: string; body: string };
  if (!threadId || !body) {
    throw new Error("gmail.create_draft requires threadId and body");
  }
  const auth = await getAuthorizedClient();
  return createDraftReply(auth, threadId, body);
}

/**
 * The egress allowlist is enforced here, inside the handler the executor
 * actually runs — not just as an earlier policy-gate check — so that an
 * approval obtained by any means (including a forced test approval, or a
 * human approving without reading closely) still can't send to a
 * recipient with no prior correspondence on file. Injection from
 * untrusted content can argue its way past a human's attention; it
 * cannot argue its way past code that never consults it.
 */
export async function handleSendDraft(args: Record<string, unknown>): Promise<unknown> {
  const { draftId } = args as { draftId: string };
  if (!draftId) {
    throw new Error("gmail.send_draft requires draftId");
  }

  const auth = await getAuthorizedClient();

  const draft = await getDraft(auth, draftId);
  if (!draft) {
    throw new Error(`Draft ${draftId} no longer exists (already sent or deleted) — refusing to send.`);
  }

  const recipient = getDraftRecipient(draft);
  if (!recipient || !(await isAllowedRecipient(recipient))) {
    throw new Error(`Refusing to send: recipient "${recipient ?? "unknown"}" has no prior correspondence on file.`);
  }

  const sent = await sendDraft(auth, draftId);
  return { messageId: sent.messageId, recipient };
}
