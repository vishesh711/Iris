import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { entities } from "../db/schema.js";

export type EntityType = "recruiter" | "unknown";

const RECRUITER_DOMAIN_HINTS = ["greenhouse.io", "lever.co", "workday.com", "myworkday.com", "smartrecruiters.com"];
const RECRUITER_KEYWORDS = ["recruiter", "recruiting", "talent acquisition", "hiring manager", "sourced you", "opportunity at"];

function extractDomain(fromAddress: string | null | undefined): string | null {
  if (!fromAddress) return null;
  const match = /@([^\s>]+)/.exec(fromAddress);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Deterministic, keyword-based — not a model call. A surprising number of
 * later detectors (recruiter follow-up, in particular) key on this
 * classification, so it needs to come from somewhere at ingest time; a
 * cheap heuristic is a defensible starting point, upgradeable to a model
 * call later without changing anything downstream that reads entity.type.
 */
export function classifySenderType(params: { fromAddress: string | null; fromName: string | null; subject: string | null; snippet: string | null }): EntityType {
  const domain = extractDomain(params.fromAddress);
  if (domain && RECRUITER_DOMAIN_HINTS.some((hint) => domain.endsWith(hint))) {
    return "recruiter";
  }

  const haystack = `${params.fromName ?? ""} ${params.subject ?? ""} ${params.snippet ?? ""}`.toLowerCase();
  if (RECRUITER_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return "recruiter";
  }

  return "unknown";
}

export async function upsertEntityForSender(params: {
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
}): Promise<string | null> {
  if (!params.fromAddress) return null;

  const type = classifySenderType(params);
  const name = params.fromName?.trim() || params.fromAddress;

  const [existing] = await db.select().from(entities).where(eq(entities.name, params.fromAddress));
  if (existing) {
    return existing.id;
  }

  const [row] = await db
    .insert(entities)
    .values({
      name: params.fromAddress,
      type,
      aliases: name !== params.fromAddress ? [name] : [],
      metadata: { source: "gmail" },
    })
    .returning();

  return row.id;
}
