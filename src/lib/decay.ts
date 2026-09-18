export const DECAY_CLASSES = ["identity", "employment", "preference", "intent", "scheduled"] as const;
export type DecayClass = (typeof DECAY_CLASSES)[number];

// Half-lives in days for the classes that decay smoothly. These are
// starting guesses per the PRD's own open question ("the classes are
// defined; the actual half-lives are guesses") — tune against real
// retrieval behavior later, in this one place, with no migration needed.
const HALF_LIFE_DAYS: Record<"employment" | "preference" | "intent", number> = {
  employment: 365,
  preference: 90,
  intent: 3,
};

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Pure function: decay is computed at query time, never stored. Returns a
 * weight in (0, 1] — 1 means fully current, approaching 0 means stale.
 * Reinforcement slows decay for the smoothly-decaying classes by scaling
 * the half-life, so a repeatedly-confirmed intent decays slower than one
 * stated once.
 */
export function decayWeight(params: {
  decayClass: DecayClass;
  lastConfirmedAt: Date;
  now: Date;
  reinforcementCount?: number;
  validUntil?: Date | null;
}): number {
  const { decayClass, lastConfirmedAt, now, reinforcementCount = 1, validUntil } = params;

  if (decayClass === "identity") {
    return 1;
  }

  if (decayClass === "scheduled") {
    if (!validUntil) return 1;
    return now.getTime() <= validUntil.getTime() ? 1 : 0;
  }

  const ageDays = Math.max(0, (now.getTime() - lastConfirmedAt.getTime()) / MS_PER_DAY);
  const halfLifeDays = HALF_LIFE_DAYS[decayClass] * Math.max(1, reinforcementCount);
  return Math.pow(0.5, ageDays / halfLifeDays);
}
