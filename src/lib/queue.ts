import "dotenv/config";
import PgBoss from "pg-boss";

export const QUEUES = {
  transcribe: "transcribe",
  classify: "classify",
  extractMemory: "extract-memory",
} as const;

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

async function start(): Promise<PgBoss> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const instance = new PgBoss(connectionString);
  instance.on("error", (err) => console.error("pg-boss error", err));
  await instance.start();
  for (const name of Object.values(QUEUES)) {
    await instance.createQueue(name);
  }
  return instance;
}

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (!starting) {
    starting = start();
  }
  boss = await starting;
  return boss;
}
