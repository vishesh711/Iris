import { eq } from "drizzle-orm";
import { topicThreadId } from "../../bot/topics.js";
import { db } from "../../db/client.js";
import { ruleRuns, rules } from "../../db/schema.js";
import { notifyOwner } from "../../lib/notify.js";
import { proposeNudge } from "../../lib/nudges.js";
import { detectRecruiterFollowUp } from "../../lib/rules/detectors/recruiter-follow-up.js";
import { detectUnansweredImportantEmail } from "../../lib/rules/detectors/unanswered-important-email.js";
import { detectUpcomingInterview } from "../../lib/rules/detectors/upcoming-interview.js";
import { filterRelevantCandidates } from "../../lib/rules/relevance-filter.js";
import type { RuleCandidate } from "../../lib/rules/types.js";

interface RuleDefinition {
  name: string;
  description: string;
  detect: () => Promise<RuleCandidate[]>;
}

const RULE_DEFINITIONS: RuleDefinition[] = [
  {
    name: "recruiter-follow-up",
    description: "A recruiter email thread has gone quiet.",
    detect: detectRecruiterFollowUp,
  },
  {
    name: "upcoming-interview",
    description: "An interview is coming up soon.",
    detect: detectUpcomingInterview,
  },
  {
    name: "unanswered-important-email",
    description: "An important email has gone unanswered.",
    detect: detectUnansweredImportantEmail,
  },
];

async function getOrCreateRule(def: RuleDefinition): Promise<typeof rules.$inferSelect> {
  const [existing] = await db.select().from(rules).where(eq(rules.name, def.name));
  if (existing) return existing;
  const [created] = await db.insert(rules).values({ name: def.name, description: def.description }).returning();
  return created;
}

/**
 * Runs each enabled rule's detector (deterministic SQL, invariant 8),
 * logs the run either way (a candidateCount of 0 vs. an error are both
 * visible in rule_runs), then makes exactly one relevance-filter model
 * call per rule reviewing its whole candidate batch — never one call per
 * candidate. proposeNudge's cooldown means re-running this on an
 * unchanged day produces no duplicate, no re-notification.
 */
export async function runDetectorsJob(): Promise<void> {
  for (const def of RULE_DEFINITIONS) {
    const rule = await getOrCreateRule(def);
    if (!rule.enabled) continue;

    try {
      const candidates = await def.detect();
      await db.insert(ruleRuns).values({ ruleId: rule.id, candidateCount: candidates.length });

      const selected = await filterRelevantCandidates(def.name, candidates);
      for (const { candidate, title, body } of selected) {
        const { created } = await proposeNudge({ ruleId: rule.id, candidate, title, body });
        if (created) {
          await notifyOwner(`🔔 ${title}\n${body}`, topicThreadId("brief"));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.insert(ruleRuns).values({ ruleId: rule.id, candidateCount: 0, error: message });
      console.error(`Detector "${def.name}" failed:`, message);
    }
  }
}
