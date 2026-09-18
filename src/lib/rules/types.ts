export interface RuleCandidate {
  /** Entity this candidate is about, when there is one — feeds the DB-level cooldown/dedupe. */
  entityId: string | null;
  /** Stable natural key for app-level dedupe when there's no entity (e.g. a calendar event). */
  dedupeKey: string;
  /** Fed to the relevance filter's single model call, and used as the nudge body if selected. */
  summary: string;
  metadata: Record<string, unknown>;
}
