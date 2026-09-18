import "dotenv/config";
import "../lib/network.js";
import { desc } from "drizzle-orm";
import express from "express";
import { db } from "../db/client.js";
import { actions, calendarEvents, emails, events, memories, ruleRuns, rules, syncState } from "../db/schema.js";
import { proposeAction, undoAction } from "../lib/actions.js";
import { answerQuestion } from "../lib/ask.js";
import { decayWeight, type DecayClass } from "../lib/decay.js";
import { dismissNudge, listActiveNudges } from "../lib/nudges.js";
import { listTools } from "../lib/tools/registry.js";

const PORT = Number(process.env.ADMIN_PORT ?? 4000);

const app = express();
app.use(express.urlencoded({ extended: true }));

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
<nav><a href="/events">Events</a><a href="/memories">Memories</a><a href="/emails">Emails</a><a href="/health">Health</a><a href="/ask">Ask</a><a href="/nudges">Nudges</a><a href="/actions">Actions</a><a href="/tools">Tools</a></nav>
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
<tr><th>Received</th><th>From</th><th>Subject</th><th>Snippet</th><th>Thread ID</th><th></th></tr>
${rows
  .map(
    (row) => `<tr>
<td>${row.receivedAt ? escapeHtml(row.receivedAt.toISOString()) : '<span class="muted">—</span>'}</td>
<td>${escapeHtml(row.fromName ?? row.fromAddress ?? "")}</td>
<td>${escapeHtml(row.subject ?? "")}</td>
<td>${escapeHtml(row.snippet ?? "")}</td>
<td>${row.threadId ? escapeHtml(row.threadId) : '<span class="muted">—</span>'}</td>
<td>${
      row.threadId
        ? `<a href="/tools?tool=gmail.create_draft&threadId=${encodeURIComponent(row.threadId)}">Draft reply</a>`
        : ""
    }</td>
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

// Manual trigger for tools that otherwise have no built-in bot command
// (gmail.create_draft/send_draft, calendar.create_event) — goes through
// proposeAction() exactly like any real caller would, so tier/approval/
// egress-allowlist/undo all behave identically to a real invocation.
// This is a deliberately blunt debug instrument (raw JSON args, no
// schema validation beyond what each handler already does) — it exists
// to exercise the write-tool pipeline for verification, not as a
// permanent product surface.
const ARG_PLACEHOLDERS: Record<string, string> = {
  "gmail.create_draft": JSON.stringify({ threadId: "", body: "" }, null, 2),
  "gmail.send_draft": JSON.stringify({ draftId: "" }, null, 2),
  "calendar.create_event": JSON.stringify(
    { title: "", description: "", location: "", startAt: "2026-01-01T10:00:00-08:00", endAt: "2026-01-01T10:30:00-08:00" },
    null,
    2
  ),
};

app.get("/tools", async (req, res, next) => {
  try {
    const tools = listTools().filter((tool) => tool.handler);
    const selectedTool = typeof req.query.tool === "string" ? req.query.tool : tools[0]?.name ?? "";
    let placeholder = ARG_PLACEHOLDERS[selectedTool] ?? "{}";
    if (selectedTool === "gmail.create_draft" && typeof req.query.threadId === "string") {
      placeholder = JSON.stringify({ threadId: req.query.threadId, body: "" }, null, 2);
    }

    const options = tools
      .map(
        (tool) =>
          `<option value="${escapeHtml(tool.name)}" ${tool.name === selectedTool ? "selected" : ""}>${escapeHtml(tool.name)} (tier ${tool.tier})</option>`
      )
      .join("\n");

    const body = `<p class="muted">Manually propose a tool call — goes through the exact same proposeAction() path as any real caller (tier gating, approval cards, egress allowlist, undo). Tier 2 tools will produce a Telegram approval card instead of executing immediately.</p>
<form method="post" action="/tools/propose">
<p><label>Tool<br><select name="tool" onchange="location = '/tools?tool=' + this.value">${options}</select></label></p>
<input type="hidden" name="toolConfirm" value="${escapeHtml(selectedTool)}">
<p><label>Args (JSON)<br><textarea name="args" rows="6" style="width: 100%; font-family: monospace;">${escapeHtml(placeholder)}</textarea></label></p>
<p><label>Rationale (optional)<br><input type="text" name="rationale" style="width: 100%; padding: 6px;" placeholder="Manual test via admin UI"></label></p>
<button type="submit">Propose</button>
</form>
<h2>Registered tools</h2>
<table>
<tr><th>Tool</th><th>Tier</th><th>Description</th></tr>
${listTools()
  .map((tool) => `<tr><td>${escapeHtml(tool.name)}</td><td>${tool.tier}</td><td>${escapeHtml(tool.description)}</td></tr>`)
  .join("\n")}
</table>`;
    res.send(layout("Tools", body));
  } catch (err) {
    next(err);
  }
});

app.post("/tools/propose", async (req, res, next) => {
  try {
    const tool = typeof req.body.toolConfirm === "string" ? req.body.toolConfirm : "";
    const rationale = typeof req.body.rationale === "string" && req.body.rationale.trim() ? req.body.rationale.trim() : "Manual test via admin UI";
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(req.body.args);
    } catch {
      res.status(400).send(layout("Tools", `<p>Args must be valid JSON.</p><p><a href="/tools?tool=${encodeURIComponent(tool)}">Back</a></p>`));
      return;
    }

    const { action, decision } = await proposeAction({ tool, args, rationale });
    const body = `<p>Proposed <code>${escapeHtml(tool)}</code> — decision: <strong>${escapeHtml(decision)}</strong>, action id <code>${escapeHtml(action.id)}</code>.</p>
<p>${decision === "queued" ? "Check the approvals topic on Telegram for the card." : 'Check <a href="/actions">/actions</a> for the result.'}</p>
<p><a href="/tools?tool=${encodeURIComponent(tool)}">Propose another</a></p>`;
    res.send(layout("Tools", body));
  } catch (err) {
    next(err);
  }
});

app.listen(PORT, () => {
  console.log(`Iris admin UI listening on http://localhost:${PORT}`);
});
