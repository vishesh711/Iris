import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { actions, toolAutonomyOverrides } from "../db/schema.js";
import { notifyOwner } from "./notify.js";

const PROMOTION_MIN_DECISIONS = 30;
const PROMOTION_MIN_APPROVAL_RATE = 0.95;
const DEMOTION_REJECTION_STREAK = 3;
const AUTO_APPROVE_LEVEL = 1;

export async function getAutonomyOverrideTier(tool: string): Promise<number | null> {
  const [row] = await db.select().from(toolAutonomyOverrides).where(eq(toolAutonomyOverrides.tool, tool));
  return row?.level ?? null;
}

export async function setAutonomyOverride(tool: string, level: number): Promise<void> {
  await db
    .insert(toolAutonomyOverrides)
    .values({ tool, level })
    .onConflictDoUpdate({ target: toolAutonomyOverrides.tool, set: { level, updatedAt: new Date() } });
}

export async function clearAutonomyOverride(tool: string): Promise<void> {
  await db.delete(toolAutonomyOverrides).where(eq(toolAutonomyOverrides.tool, tool));
}

/**
 * Never self-promotes: at >=30 decided proposals with ~95%+ approval,
 * this only offers to make the tool automatic — the person has to
 * explicitly say yes (via /autonomy <tool> on) before anything changes.
 * A tool already overridden is skipped, so this doesn't nag on every
 * decision once promoted.
 */
export async function checkAutonomyPromotion(tool: string): Promise<void> {
  if ((await getAutonomyOverrideTier(tool)) !== null) return;

  const decided = await db
    .select({ status: actions.status })
    .from(actions)
    .where(and(eq(actions.tool, tool), isNotNull(actions.decidedAt)));

  const total = decided.length;
  if (total < PROMOTION_MIN_DECISIONS) return;

  const approvedCount = decided.filter((d) => d.status !== "rejected").length;
  const approvalRate = approvedCount / total;
  if (approvalRate < PROMOTION_MIN_APPROVAL_RATE) return;

  await notifyOwner(
    `You've approved ${approvedCount}/${total} requests for "${tool}". Want me to handle these automatically from now on? Reply /autonomy ${tool} on (or /autonomy ${tool} off to keep it as-is).`
  );
}

/**
 * Symmetric demotion doesn't ask, unlike promotion: erring back toward
 * more oversight never needs permission. A streak of rejections right
 * after being auto-approved is exactly the "this was a bad idea" signal.
 */
export async function checkAutonomyDemotion(tool: string): Promise<void> {
  if ((await getAutonomyOverrideTier(tool)) === null) return;

  const recent = await db
    .select({ status: actions.status })
    .from(actions)
    .where(and(eq(actions.tool, tool), isNotNull(actions.decidedAt)))
    .orderBy(desc(actions.decidedAt))
    .limit(DEMOTION_REJECTION_STREAK);

  if (recent.length === DEMOTION_REJECTION_STREAK && recent.every((r) => r.status === "rejected")) {
    await clearAutonomyOverride(tool);
    await notifyOwner(`Noticed ${DEMOTION_REJECTION_STREAK} rejections in a row for "${tool}" — switched it back to requiring approval.`);
  }
}

export { AUTO_APPROVE_LEVEL };
