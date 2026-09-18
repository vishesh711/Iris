import "dotenv/config";
import "../lib/network.js";
import { desc } from "drizzle-orm";
import express from "express";
import { db } from "../db/client.js";
import { actions, calendarEvents, emails, events, memories, ruleRuns, rules, syncState } from "../db/schema.js";
import { undoAction } from "../lib/actions.js";
import { answerQuestion } from "../lib/ask.js";
import { decayWeight, type DecayClass } from "../lib/decay.js";
import { dismissNudge, listActiveNudges } from "../lib/nudges.js";

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
<nav><a href="/events">Events</a><a href="/memories">Memories</a><a href="/emails">Emails</a><a href="/health">Health</a><a href="/ask">Ask</a><a href="/nudges">Nudges</a><a href="/actions">Actions</a></nav>
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

app.get("/emails", async (_req, res, next) => {
  try {
    const rows = await db.select().from(emails).orderBy(desc(emails.receivedAt)).limit(50);
    const body = `<table>
<tr><th>Received</th><th>From</th><th>Subject</th><th>Snippet</th></tr>
${rows
  .map(
    (row) => `<tr>
<td>${row.receivedAt ? escapeHtml(row.receivedAt.toISOString()) : '<span class="muted">—</span>'}</td>
<td>${escapeHtml(row.fromName ?? row.fromAddress ?? "")}</td>
<td>${escapeHtml(row.subject ?? "")}</td>
<td>${escapeHtml(row.snippet ?? "")}</td>
</tr>`
  )
  .join("\n")}
</table>`;
    res.send(layout(`Emails (${rows.length})`, body));
  } catch (err) {
    next(err);
  }
});

app.get("/health", async (_req, res, next) => {
  try {
    const [syncRows, emailCount, calendarCount] = await Promise.all([
      db.select().from(syncState),
      db.$count(emails),
      db.$count(calendarEvents),
    ]);
    const now = Date.now();
    const body = `<table>
<tr><th>Source</th><th>Last synced</th><th>Lag</th><th>Last error</th></tr>
${syncRows
  .map((row) => {
    const lagMs = row.lastSyncedAt ? now - row.lastSyncedAt.getTime() : null;
    const lagText = lagMs === null ? "never synced" : `${Math.round(lagMs / 1000)}s ago`;
    return `<tr>
<td>${escapeHtml(row.key)}</td>
<td>${row.lastSyncedAt ? escapeHtml(row.lastSyncedAt.toISOString()) : '<span class="muted">—</span>'}</td>
<td>${escapeHtml(lagText)}</td>
<td>${row.lastError ? escapeHtml(row.lastError) : '<span class="muted">none</span>'}</td>
</tr>`;
  })
  .join("\n")}
</table>
<p>${emailCount} emails ingested, ${calendarCount} calendar events ingested.</p>`;
    res.send(layout("System health", body));
  } catch (err) {
    next(err);
  }
});

app.get("/ask", async (req, res, next) => {
  try {
    const question = typeof req.query.q === "string" ? req.query.q : "";
    const form = `<form method="get" action="/ask">
<input name="q" type="text" style="width: 70%; padding: 6px;" placeholder="Ask a question..." value="${escapeHtml(question)}">
<button type="submit">Ask</button>
</form>`;

    if (!question.trim()) {
      res.send(layout("Ask", form));
      return;
    }

    const answer = await answerQuestion(question);
    const body = `${form}<h2>Question</h2><p>${escapeHtml(question)}</p><h2>Answer</h2><pre>${escapeHtml(answer)}</pre>`;
    res.send(layout("Ask", body));
  } catch (err) {
    next(err);
  }
});

app.get("/nudges", async (_req, res, next) => {
  try {
    const [ruleRows, runRows, activeNudges] = await Promise.all([
      db.select().from(rules),
      db.select().from(ruleRuns).orderBy(desc(ruleRuns.ranAt)).limit(50),
      listActiveNudges(),
    ]);
    const ruleNameById = new Map(ruleRows.map((rule) => [rule.id, rule.name]));

    const rulesTable = `<table>
<tr><th>Rule</th><th>Enabled</th><th>Description</th></tr>
${ruleRows
  .map(
    (rule) => `<tr>
<td>${escapeHtml(rule.name)}</td>
<td>${rule.enabled ? "yes" : "no"}</td>
<td>${escapeHtml(rule.description ?? "")}</td>
</tr>`
  )
  .join("\n")}
</table>`;

    const nudgesTable = `<table>
<tr><th>Rule</th><th>Title</th><th>Body</th><th>Sent</th><th></th></tr>
${activeNudges
  .map(
    (nudge) => `<tr>
<td>${escapeHtml(ruleNameById.get(nudge.ruleId) ?? nudge.ruleId)}</td>
<td>${escapeHtml(nudge.title)}</td>
<td>${escapeHtml(nudge.body ?? "")}</td>
<td>${nudge.sentAt ? escapeHtml(nudge.sentAt.toISOString()) : '<span class="muted">—</span>'}</td>
<td><form method="post" action="/nudges/${nudge.id}/dismiss"><button type="submit">Dismiss</button></form></td>
</tr>`
  )
  .join("\n")}
</table>`;

    const runsTable = `<table>
<tr><th>Rule</th><th>Ran at</th><th>Candidates</th><th>Error</th></tr>
${runRows
  .map(
    (run) => `<tr>
<td>${escapeHtml(ruleNameById.get(run.ruleId) ?? run.ruleId)}</td>
<td>${escapeHtml(run.ranAt.toISOString())}</td>
<td>${run.candidateCount}</td>
<td>${run.error ? escapeHtml(run.error) : '<span class="muted">—</span>'}</td>
</tr>`
  )
  .join("\n")}
</table>`;

    const body = `<h2>Rules</h2>${rulesTable}<h2>Active nudges (${activeNudges.length})</h2>${nudgesTable}<h2>Recent runs</h2>${runsTable}`;
    res.send(layout("Nudges", body));
  } catch (err) {
    next(err);
  }
});

app.post("/nudges/:id/dismiss", async (req, res, next) => {
  try {
    await dismissNudge(req.params.id);
    res.redirect("/nudges");
  } catch (err) {
    next(err);
  }
});

app.get("/actions", async (_req, res, next) => {
  try {
    const rows = await db.select().from(actions).orderBy(desc(actions.proposedAt)).limit(100);
    const body = `<table>
<tr><th>Proposed</th><th>Tool</th><th>Tier</th><th>Status</th><th>Untrusted</th><th>Rationale</th><th>Args</th><th>Result</th><th>Undo</th></tr>
${rows
  .map((row) => {
    const canUndo = row.status === "done" && row.undoPayload && !row.undoneAt;
    const undoCell = row.undoneAt
      ? `<span class="muted">undone ${escapeHtml(row.undoneAt.toISOString())}</span>`
      : canUndo
        ? `<form method="post" action="/actions/${row.id}/undo"><button type="submit">Undo</button></form>`
        : '<span class="muted">not available</span>';
    return `<tr>
<td>${escapeHtml(row.proposedAt.toISOString())}</td>
<td>${escapeHtml(row.tool)}</td>
<td>${row.tier}</td>
<td>${escapeHtml(row.status)}</td>
<td>${row.untrusted ? "⚠️ yes" : "no"}</td>
<td>${row.rationale ? escapeHtml(row.rationale) : '<span class="muted">—</span>'}</td>
<td>${renderJson(row.args)}</td>
<td>${renderJson(row.result)}</td>
<td>${undoCell}</td>
</tr>`;
  })
  .join("\n")}
</table>`;
    res.send(layout(`Tool call audit (${rows.length})`, body));
  } catch (err) {
    next(err);
  }
});

app.post("/actions/:id/undo", async (req, res, next) => {
  try {
    await undoAction(req.params.id);
    res.redirect("/actions");
  } catch (err) {
    next(err);
  }
});

app.listen(PORT, () => {
  console.log(`Iris admin UI listening on http://localhost:${PORT}`);
});
