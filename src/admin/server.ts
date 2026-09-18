import "dotenv/config";
import { desc } from "drizzle-orm";
import express from "express";
import { db } from "../db/client.js";
import { events, memories } from "../db/schema.js";
import { decayWeight, type DecayClass } from "../lib/decay.js";

const PORT = Number(process.env.ADMIN_PORT ?? 4000);

const app = express();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — Iris admin</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 2rem; color: #111; background: #fff; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 0.82rem; vertical-align: top; }
  th { background: #f5f5f5; position: sticky; top: 0; }
  nav { margin-bottom: 1rem; }
  nav a { margin-right: 1rem; font-weight: 600; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; max-width: 480px; }
  .muted { color: #888; }
</style>
</head>
<body>
<nav><a href="/events">Events</a><a href="/memories">Memories</a></nav>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}

function renderJson(value: unknown): string {
  if (value === null || value === undefined) return `<span class="muted">—</span>`;
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

app.get("/", (_req, res) => {
  res.redirect("/events");
});

app.get("/events", async (_req, res, next) => {
  try {
    const rows = await db.select().from(events).orderBy(desc(events.receivedAt)).limit(50);
    const body = `<table>
<tr><th>Received</th><th>Processed</th><th>Source</th><th>Type</th><th>Raw data</th><th>Metadata</th></tr>
${rows
  .map(
    (row) => `<tr>
<td>${escapeHtml(row.receivedAt.toISOString())}</td>
<td>${row.processedAt ? escapeHtml(row.processedAt.toISOString()) : '<span class="muted">—</span>'}</td>
<td>${escapeHtml(row.source)}</td>
<td>${escapeHtml(row.type)}</td>
<td>${renderJson(row.rawData)}</td>
<td>${renderJson(row.metadata)}</td>
</tr>`
  )
  .join("\n")}
</table>`;
    res.send(layout(`Recent events (${rows.length})`, body));
  } catch (err) {
    next(err);
  }
});

app.get("/memories", async (_req, res, next) => {
  try {
    const rows = await db.select().from(memories).orderBy(desc(memories.createdAt)).limit(200);
    const now = new Date();
    const body = `<table>
<tr><th>Statement</th><th>Subject</th><th>Certainty</th><th>Decay class</th><th>Weight</th><th>Status</th><th>Reinforced</th><th>Supersedes</th><th>Created</th></tr>
${rows
  .map((row) => {
    const weight = decayWeight({
      decayClass: row.decayClass as DecayClass,
      lastConfirmedAt: row.lastConfirmedAt,
      now,
      reinforcementCount: row.reinforcementCount,
      validUntil: row.validUntil,
    });
    return `<tr>
<td>${escapeHtml(row.statement)}</td>
<td>${row.subject ? escapeHtml(row.subject) : '<span class="muted">—</span>'}</td>
<td>${escapeHtml(row.certainty)}</td>
<td>${escapeHtml(row.decayClass)}</td>
<td>${weight.toFixed(2)}</td>
<td>${escapeHtml(row.status)}</td>
<td>${row.reinforcementCount}</td>
<td>${row.supersedes ? escapeHtml(row.supersedes) : '<span class="muted">—</span>'}</td>
<td>${escapeHtml(row.createdAt.toISOString())}</td>
</tr>`;
  })
  .join("\n")}
</table>`;
    res.send(layout(`Memories (${rows.length})`, body));
  } catch (err) {
    next(err);
  }
});

app.listen(PORT, () => {
  console.log(`Iris admin UI listening on http://localhost:${PORT}`);
});
