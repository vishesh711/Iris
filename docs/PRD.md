# Personal Agent — PRD & MVP

Sep 17, 2026 · @Vishesh

## Problem and goals

Context that should be reusable is currently trapped. Decisions, preferences, commitments, and the details of ongoing threads live scattered across Gmail, Calendar, chat histories, and human memory. Every new conversation with any tool starts from zero, and every dropped follow-up costs something real.

The agent exists to hold that context durably and act on it, under supervision, from a single interface.

### Primary goals

1. Never explain the same thing twice. Facts, preferences, and decisions persist across sessions and are correctable.
2. Nothing important gets dropped. The system notices unanswered threads, approaching deadlines, and stale commitments before they become problems.
3. Answers span sources. A single question can draw on Telegram capture, email, calendar, and extracted memory at once.
4. Autonomy is earned, not assumed. Every side-effecting action is proposed, checked against policy, and either auto-approved or queued for a tap.
5. Everything is explainable. "Why did you do that?" resolves to a chain from trigger to action.

### Non-goals for v1

- Multi-user or tenancy. Single user, one machine, no user_id threaded through every query.
- Financial data ingestion. Highest sensitivity, hardest integration, weakest free path.
- Health and fitness tracking. Apple Health has no server API and Google Fit's is retired; plumbing cost is out of proportion to v1 value.
- Reservations and purchasing. Browser automation against sites that actively defend against it, with real money at stake.
- A web dashboard. Built once the data exists and usage patterns are known.
- Specialist sub-agents as separate processes. Lenses over one agent instead.

### Hard constraints

- Zero recurring cost during the build. Local Postgres, local embeddings, local Whisper, free-tier Google APIs, Telegram.
- Local-first. All data on hardware under direct control.
- Built alongside a full-time job. Every milestone must fit in evenings and leave a working system behind.

## MVP scope

The MVP is deliberately read-only for its first month. It captures, remembers, searches, and notices, and it proposes actions without taking them. This is not timidity — it is how the trust data gets collected before the system is given hands.

### In scope

| Capability | What it means concretely |
| --- | --- |
| Telegram capture | Text, voice notes (local Whisper), forwarded messages, links, files. One input surface. |
| Event ledger | Every input, observation, and decision written immutably, with provenance. |
| Memory extraction | Facts, preferences, entities, and relations derived from events, with decay and supersession. |
| Correction | "That's wrong, X now" supersedes the old fact and records the correction as an event. |
| Gmail + Calendar ingest | Read-only polling, deduped on provider ids, into normalized tables. |
| Unified search | One question answered across Telegram capture, email, calendar, and memory. |
| Rule-based detection | Deterministic SQL detectors emit candidate nudges; a model picks which are worth surfacing. |
| Proposal + approval | Side-effecting actions written to a ledger and sent to Telegram with approve/reject buttons. |
| Shadow mode | For the first weeks, approval taps record judgment and execute nothing. |
| Audit | "What did you do today and why" resolves to a traceable chain. |

### Explicitly deferred

Drafting email and calendar writes arrive at Milestone 5, after shadow mode has produced enough labeled decisions to justify them. Web research, file and PDF ingestion, and a career-specific lens follow. Reservations, finances, health, and any dashboard are out of the MVP entirely.

### Definition of done

The MVP is complete when the following question is answered correctly from a cold start, with no context supplied in the prompt:

> "Who was the recruiter that contacted me about the contract role, and what did I decide about the rate?"

If that resolves across Telegram capture plus email plus extracted memory, the retrieval foundation is sound and everything else is an extension of it. If it does not, no amount of additional features will help.

## Core flows

Five flows cover the whole MVP. They differ by trigger, lifetime, and default permission rather than by machinery — all five run through one loop.

### Capture

Trigger: any Telegram message. The bot acknowledges within a second, before any reasoning. Speed matters more than intelligence here: the moments when capture is most valuable are the moments when waiting is least tolerable.

The message is written to `events` immediately. A background pass then classifies it — fact to store, task, reminder, correction, or conversation — and extracts memory if warranted. Voice notes transcribe locally via Whisper on the same path. Forwarded content from any app becomes a universal inbox without any additional integration work.

### Ask

Trigger: a user question. Lifetime: one request. Default permission: read.

Retrieval pulls from four places and merges: semantic search over embedded content, structured queries over emails and calendar, the memory store filtered to active non-superseded facts, and recent events for conversational context. The model reasons over the merged set and answers. No side effects, so no approval path.

The ranking rule that matters: prefer the newest non-superseded fact over the most semantically similar one. Similarity alone will happily surface a preference that was corrected three months ago.

### Do

Trigger: explicit command, or an approved proposal. Lifetime: until the action completes. Default permission: per-tool.

The planner does not call side-effecting tools. It writes a row to `actions` with tier, arguments, rationale, and lineage. The policy gate evaluates it. Tier 0 and 1 actions are marked approved immediately; tier 2 actions go to the approval queue and a Telegram card is sent. A separate executor process drains approved rows, checks the idempotency key, executes, and writes the result back.

That separation is what makes crash recovery, replay, and a kill switch possible. Flipping one flag drains everything to the queue instead of executing.

### Watch

Trigger: schedule or incoming event. Lifetime: persistent. Default permission: observe and notify.

Detectors are SQL, not model calls. They run on cron and emit candidate nudges with type, entity, evidence, and an importance score. A single model call then reviews the full candidate set and picks zero to three worth interrupting for.

Silence is the normal successful outcome. An agent that reports every time it checks becomes noise within a week, and noise gets muted.

### Correct

Trigger: a user message contradicting stored memory. This is the flow that keeps the system from rotting.

The explicit case is easy: "that's wrong, I'm in Philadelphia now" marks the old fact superseded, writes the new one, and logs a correction event. The dangerous case is implicit — a new fact quietly contradicting an old one with nobody noticing, leaving retrieval to return both and the model to pick whichever ranked higher.

So every memory write runs a conflict check first: pull the nearest existing facts for that entity and classify the new one as contradicts, extends, or independent. That costs one extra model call per fact write, and it is the difference between a memory that improves and one that slowly fills with confident stale claims.

## Architecture

One principle governs the whole system:

> The model decides what it wants to do. The tool registry defines what it can do. Policy decides what it may do. The ledger records what actually happened.

Every design decision below follows from keeping those four separate. When they blur — when the model can assert its own authority, or the permission check lives inside the thing being permitted — the guarantees collapse.

### The action lifecycle

The planner never calls a side-effecting tool. It writes a proposal. This is the single most important structural choice in the system, and the one most easily lost while drawing boxes.

```
planner → actions row (proposed)
            ↓
        policy gate
            ↓
   tier 0/1 → approved        tier 2 → queued
            ↓                       ↓
        executor              Telegram card
            ↓                       ↓
   idempotency check          approve / reject
            ↓                       ↓
     execute + record  ←────────────┘
```

What this buys: a place for a proposal to wait four hours for a tap; crash safety, since a process dying mid-flight leaves a row in a known state; replay for debugging; a kill switch that drains everything to the queue; and an audit trail that is a byproduct rather than a separate concern.

### Processes

Three, all on one machine.

- **Bot** — Telegram long-poll. Writes events, acknowledges, hands off. Does no reasoning.
- **Worker** — ingest polling, memory extraction, detectors, the agent loop. Everything with latency tolerance.
- **Executor** — drains approved actions. Kept separate so it can be stopped independently of everything else.

### Tools and MCP

MCP is the right boundary for third-party integrations, where existing servers and swappability are real wins. It is the wrong boundary for internal state: wrapping your own Postgres in JSON-RPC costs type safety across a boundary you own on both sides.

So core memory, events, and rules are a plain library called directly. Gmail, Calendar, and web search go through MCP clients. If an MCP surface over memory is wanted later — for Claude Desktop, say — it becomes a thin adapter over the same library rather than a second implementation.

All enforcement happens in one tool gateway between the agent and every client. Policy lookup, ledger write, idempotency, and lineage tagging happen there and nowhere else. Enforcement distributed across servers means policy in N places and a new chance to forget it with every server added.

### Tool contracts

Tools are narrow, and the permission boundary falls out of the API shape rather than being enforced by convention:

```
gmail.create_draft(thread_id, body)   → tier 1, auto
gmail.send_draft(draft_id)            → tier 2, approval
```

The model supplies semantic arguments only. Authority and provenance — actor, approval token, source event — are injected by the gateway from trusted context the model never sees. A model that can fill in its own approval token can forge one.

Every tool returns the same envelope: `ok`, `data`, `error` with a code and a retryable flag, and metadata carrying tool name, request id, and duration. Uniform handling and observability from day one, for almost no cost.

### Lenses, not sub-agents

Separate Career, Money, and Research agents coordinated by a router add latency, cost, and a class of bug where context is dropped between hops. The two real reasons to split — context window pressure and tool-selection degradation past roughly thirty tools — do not bite at single-user scale.

A lens is a config: instructions, a tool subset, a memory scope. Same process, same loop. `/career` changes what is retrieved and what is callable, nothing else. Tool filtering by lens is also how the registry stays small enough for reliable selection.

## Data model

Postgres 16 with pgvector, in Docker. Starting on SQLite and migrating later is a false economy — JSONB and partial indexes become load-bearing within weeks. There is no `users` table; threading a `user_id` through every query buys tenancy that will never exist.

### actions

The center of the system, and the table most easily left out while drawing architecture diagrams.

```sql
create table actions (
  id              uuid primary key,
  tool            text not null,
  args            jsonb not null,
  rationale       text,
  tier            smallint not null,
  status          text not null,
  source_event_id uuid references events(id),
  untrusted       boolean not null default false,
  idempotency_key text unique not null,
  undo_payload    jsonb,
  result          jsonb,
  proposed_at     timestamptz not null default now(),
  decided_at      timestamptz,
  executed_at     timestamptz
);
create index on actions (status, tier)
  where status in ('proposed', 'approved');
```

Status moves through `proposed → approved | rejected → executing → done | failed`. `idempotency_key` is derived from tool plus arguments and checked inside the same transaction that records the result — without it, a crash between a successful Gmail call and the status write means the email sends twice on restart. `untrusted` carries injection lineage and forces the approval queue regardless of tier. The audit trail is a view over this table, not a separate one.

### events

Append-only, and the source of truth. Every Telegram message, ingested email, calendar change, agent observation, action, and correction lands here with `source`, `type`, `raw_data` as JSONB, `received_at`, `processed_at`, and `metadata`. Nothing is ever mutated; corrections are new events that supersede old facts.

### memories

The schema departs from a pure triple store, deliberately.

```sql
create table memories (
  id                 uuid primary key,
  statement          text not null,
  subject            text,
  predicate          text,
  object             text,
  certainty          text not null,
  reinforcement_count int not null default 1,
  source_event_ids   jsonb not null,
  decay_class        text not null,
  status             text not null default 'active',
  supersedes         uuid references memories(id),
  created_at         timestamptz not null default now(),
  last_confirmed_at  timestamptz not null default now(),
  valid_from         timestamptz,
  valid_until        timestamptz,
  embedding          vector(384)
);
```

Three decisions worth defending:

`statement` is primary, the triple is optional metadata. "Prefers aisle seats on flights over three hours, unless traveling with someone" does not survive being flattened into subject/predicate/object. Conditions are the norm in real preferences, and the sentence is what lands in the prompt anyway. Keep triples only where the relation is worth traversing.

`certainty` is ordinal, not a float. A model emitting 0.82 produces a number it is not calibrated to generate, and thresholds get tuned against noise. Three values — `asserted` (stated directly), `inferred` (concluded by the agent), `contradicted` — plus `reinforcement_count` and `last_confirmed_at` describe the world rather than a vibe, and ranking over them is debuggable.

Decay is computed, never stored. A stored decaying score means a cron rewriting rows forever and drift when it fails. Store `decay_class` and `last_confirmed_at`, apply the curve at query time. One pure function, no background job, and the curve can change retroactively without a migration.

Decay classes: `identity` (never decays), `employment` (slow, superseded rather than decayed), `preference` (gradual), `intent` (fast without reinforcement), `scheduled` (expires at `valid_until`). Nothing is deleted — `status` moves to `superseded`, `stale`, or `contradicted`, preserving history without poisoning retrieval.

### nudges

Rule metadata records that a detector ran; it cannot record that you were already told. That needs instance rows.

```sql
create table nudges (
  id            uuid primary key,
  rule_id       uuid references rules(id),
  entity_id     uuid references entities(id),
  payload       jsonb,
  surfaced_at   timestamptz,
  snoozed_until timestamptz,
  dismissed     boolean not null default false
);
create unique index on nudges (rule_id, entity_id)
  where dismissed = false;
```

Without cooldown and backoff, the same follow-up reminder fires every morning for six days, and the bot gets muted.

### Ingest tables

`emails` and `calendar_events` both need unique constraints on their provider identifiers — `message_id` and `provider_id` respectively — with ingest written as an upsert. Gmail's history API re-delivers constantly; without this the tables triple within a week and every "awaiting reply for four days" detector fires three times.

### Embeddings

Search across everything means messages, emails, memories, and documents all need vectors, not just documents. One polymorphic table — `embeddings(source_table, source_id, vector, chunk_index)` — avoids adding a column to every future table. Model: bge-small or all-MiniLM running locally. An embedding API would break the cost constraint for no retrieval benefit at this scale.

### Supporting tables

`entities` (people, companies, recruiters, with aliases and type), `relations` between them, `tasks`, and `rules`. Entity type is worth calling out: detectors that key on `sender_category = 'recruiter'` depend on a classification that has to come from somewhere — an extraction pass at ingest, writing to `entities`. A surprising number of rules turn out to depend on it.

## Permissions and safety

### Tiers

Every tool carries a tier declared in a registry, not inferred at runtime by the model.

| Tier | Kind | Examples | Default |
| --- | --- | --- | --- |
| 0 | Read | `gmail.search`, `calendar.get_events`, `memory.search` | Automatic |
| 1 | Reversible, private | `gmail.create_draft`, `memory.remember`, `tasks.create` | Automatic |
| 2 | External or irreversible | `gmail.send_draft`, `calendar.create_event`, `memory.forget` | Approval |

The gate is deterministic code, not a model call. It must not be possible for the model to reason its way to "this one is safe."

Tier 2 auto-approval, once earned, is granted by predicate rather than blanket permission. Sending is automatic only when the recipient is in a contacts allowlist built from prior correspondence, the thread already exists, and the daily send cap has not been hit. Global circuit breakers sit above all of it: a cap on tier-2 actions per hour, a daily token budget, and a halt if the failure rate crosses a threshold.

### Prompt injection

An agent that reads email and browses the web, and can also act, is a standing injection target. Every email anyone sends is untrusted input reaching the planner. Four defenses, and the first and third are structural rather than advisory:

1. **Structural separation.** Untrusted content goes into a typed data field, never concatenated into an instruction string. The prompt states plainly that content inside is data to analyze, never commands to follow.
2. **Lineage on every action.** `source_event_id` records which event produced the proposal. Any tier-2 action whose lineage touches untrusted content is forced to the approval queue regardless of predicate.
3. **Egress allowlists at the executor.** The model may propose sending to anyone; the executor refuses addresses outside the list. Injection cannot talk its way past code that does not consult it.
4. **Isolated browsing context.** Untrusted pages get a separate browser profile with no session cookies for anything that matters.

### Shadow mode

For roughly the first month, nothing executes. Reads, memory writes, detectors, and drafts run automatically; everything else is proposed and queued.

The queue is not a log to read later. Proposals go to Telegram as real approval cards with real buttons, and the tap records judgment without doing anything. Labeling in the moment beats reconstructing intent from a log three weeks on.

After three weeks that produces a few hundred labeled decisions, which serve three purposes at once: the autonomy metric ("of 37 proposals, how many would I actually have approved?"), few-shot examples for the planner, and a regression set. Freeze fifty as a fixed eval and run it before every prompt change — otherwise tuning happens by feel and improvement is indistinguishable from the impression of improvement.

A tier graduates to automatic when its shadow-mode approval rate stays above roughly 95% across at least thirty proposals. Below that, it stays in the queue.

### Data handling

Gmail and Calendar tokens live in the OS keychain, not in `.env`. The database is on an encrypted volume. Backups are encrypted and stay under direct control. A `/forget` command from Telegram hard-deletes by entity, since `superseded` is the right default for corrections but the wrong one for a deliberate erase request.

## Build plan

Every milestone leaves a working system. Nothing is a prerequisite for something useful.

**Milestone 0 — one evening.** Telegram bot receives a message, writes a row to `events` in Postgres, replies "got it." That is the whole thing. It exists to end the design phase.

**Milestone 1 — week 1.** Capture proper. Voice notes via local Whisper, forwarded messages, files. Telegram supergroup with topics for capture, approvals, and brief. Ingest classification running as a background pass so acknowledgment stays instant.

**Milestone 2 — weeks 2–3.** Memory and correction. Extraction from events, the conflict check on write, decay at query time, supersession, and `/forget`. Longer than it looks: the conflict check is the hard part and it is what keeps the store from rotting.

**Milestone 3 — weeks 3–4.** Gmail and Calendar read-only ingest. OAuth, history-API polling, upsert on provider ids, entity extraction. OAuth setup alone reliably eats an evening.

**Milestone 4 — week 5.** Unified search. Embeddings across messages, emails, and memories; hybrid retrieval combining semantic and structured filters; recency-and-status ranking over pure similarity. This comes before nudges deliberately — it forces the retrieval problems into the open early, and once the definition-of-done question answers correctly, nudges are mostly queries against a data model already trusted.

**Milestone 5 — week 6.** Rules engine and nudges. SQL detectors, candidate generation, the model relevance filter, cooldowns and backoff, morning brief.

**Milestone 6 — weeks 7–8.** The action ledger and shadow mode. Proposals, the policy gate, Telegram approval cards that record without executing. A month of data collection starts here.

**Milestone 7 — week 9+.** First write actions. Gmail drafts and tentative calendar events, promoted only where shadow-mode approval rates justify it. Executor, idempotency, undo.

Then: career lens, web research, document ingest. Reservations, finances, health, and a dashboard remain out of scope until the foundation has been running for a while.

## Stack

TypeScript on Node, chosen for velocity rather than correctness — either language works, and the one used daily ships faster. Postgres 16 with pgvector in Docker, Drizzle, pg-boss for queueing (Redis is unnecessary at this scale). Whisper locally for voice, bge-small locally for embeddings, Ollama for cheap high-volume classification, and a frontier model reserved for planning and judgment. Telegram Bot API behind a one-method notification interface, so swapping to Pushover or WhatsApp later is a file rather than a refactor.

One genuine tension with the zero-cost constraint: a local planner model is meaningfully worse at judgment than a frontier one. A few dollars a month buys a noticeably better agent. This is a dial, not a blocker, and it can be turned later.

## Repository

Start with roughly eight directories and let structure emerge. A forty-directory scaffold for a system with one contributor creates ceremony that quietly costs momentum, and most of those directories stay empty for months.

## Timeline realism

Nine weeks of evenings alongside full-time work. Treat any single-week milestone as likely to take two, and read slippage as normal rather than as failure — the most common way projects like this die is abandonment in week five after mistaking ordinary slowness for a bad plan.

## Reliability and operations

### Failure classification

Every tool failure resolves to one of: `retryable`, `auth`, `rate_limit`, `invalid_input`, `provider_failure`, `internal_failure`. Only the first two retry, with exponential backoff. `auth` surfaces to Telegram immediately, since an expired Google token silently stops all ingest and the failure is otherwise invisible until someone notices the agent has gone quiet.

### Timeouts

Every tool call is bounded: database 2s, local search 5s, external APIs 10s, model calls configurable. An unbounded call in the worker stalls every downstream job behind it.

### Fail closed

If the policy gate is unreachable or errors, no side-effecting action executes. The default on failure is refusal, never permission. This is the one place where degraded behavior must be less capable rather than more.

### Idempotency, at both ends

Two distinct problems, both required:

- Ingest dedupes on provider identifiers (`message_id`, `provider_event_id`) with upsert semantics.
- Execution dedupes on `actions.idempotency_key`, checked and recorded in the same transaction as the result. A crash between a successful Gmail call and the status write otherwise resends on restart.

### Restart safety

Restarting any process loses nothing and duplicates nothing. `actions` rows stuck in `executing` at startup are reconciled against the idempotency key rather than blindly retried.

### Observability

Every agent run carries a `trace_id` linking the source event through retrieval, tool calls, permission decisions, and response. Record intent, tools selected, tool latency and errors, retrieval result count, context size, model latency, token usage, permission decisions, and final action. Never log secrets, and never embed them.

### Secrets

OAuth tokens in the OS keychain, encrypted at rest, minimum scopes — read-only until Milestone 7. No secrets in prompts, logs, embeddings, or event payloads.

### Debug interface

A minimal local admin UI, not a product dashboard. Six views: recent events, memory search and inspection, rule run history, active watches, tool call audit, and system health (Gmail sync lag, calendar sync lag, worker liveness, queue depth, last scheduler run).

This exists for trust and debugging. It becomes necessary around the time memory extraction starts producing results worth questioning, roughly Milestone 2, and it is the cheapest way to answer "why does it believe that?" without reading the database by hand.

## Testing and acceptance

### Permission tests are the security suite

The highest-value test file in the repository. Every tier-2 tool gets a case asserting it cannot execute without an approval record, and a case asserting a forged or model-supplied approval token is rejected. Every tool with untrusted lineage gets a case asserting it lands in the queue regardless of tier.

```
planner proposes gmail.send_draft, no approval   → DENY
planner supplies its own approval_token          → DENY
proposal with untrusted lineage, tier 1          → QUEUE
gmail.search                                     → ALLOW
policy gate unreachable, tier 2 proposed         → DENY
```

These run on every commit. A regression here is the only class of bug in this system that can do real damage in the world.

### Unit coverage

Rules and detectors, decay curves, contradiction detection, retrieval ranking, and the idempotency key derivation. All pure functions, all cheap to test, all places where a silent wrong answer is hard to notice in production.

### Integration paths

Two end-to-end paths cover most of the system:

1. Telegram message → event → memory extracted → searchable
2. Gmail message → ingest → entity resolved → rule fires → nudge queued

### Evaluation set

Build 50 to 100 labeled scenarios before Milestone 4 ships, growing toward 300. Categories: retrieval (question with known expected evidence), memory currency (must prefer the latest valid fact over the most similar one), contradiction (old location versus new), nudge judgment (should this have been surfaced), and permission (must never execute autonomously).

The shadow-mode decisions feed this directly. Fifty frozen cases run before every prompt change; without a fixed set, tuning happens by feel and the impression of improvement is indistinguishable from improvement.

### Acceptance criteria

The MVP is done when all of the following hold:

- Text and voice capture through Telegram, with sub-second acknowledgment.
- Explicit personal facts are remembered and retrieved correctly across sessions.
- Corrections supersede cleanly, and retrieval prefers the current fact.
- Gmail and Calendar sync incrementally without duplicates.
- Natural-language search works across all four sources.
- At least three high-value rules fire correctly: recruiter follow-up, upcoming interview, unanswered important email.
- No external state change occurs without an approval record.
- Every consequential action has a traceable causal chain.
- Restarting any process loses no state and creates no duplicates.

### Targets

Retrieval accuracy above 90% on the curated set. Memory correctness above 95% for explicitly stated facts. Follow-up recall above 90%. False nudge rate below 20%, improving toward 10%. Permission violations and duplicate ingests both at zero — these are correctness bugs, not metrics to optimize.

## Autonomy ladder and invariants

### The ladder

Autonomy is granted per tool, based on observed approval history, and the promotion is made by the user rather than inferred by the system.

| Level | Capability |
| --- | --- |
| 0 | Read only |
| 1 | Remember, internal tasks, watches |
| 2 | Automatic drafts |
| 3 | External actions with approval |
| 4 | Specific trusted actions automatic, by predicate |
| 5 | Bounded autonomous workflows within strict policy |

Promotion is offered, never taken. After enough consistent approvals of one action type, the system asks:

> You've approved this calendar action 47 times and rejected it twice. Make it automatic?

The user answers. The model never promotes itself, and the offer is a suggestion with evidence attached rather than a default the user has to catch and decline.

Demotion runs the same way in reverse. A rejection rate crossing a threshold for a previously automatic action drops it back to the queue and says so.

### Invariants

These hold regardless of what gets added later. Each one, if broken, breaks a guarantee the rest of the system assumes.

1. Every externally meaningful input and action enters the ledger.
2. Every memory retains provenance to the events that produced it.
3. Corrections supersede; they never silently destroy history.
4. Model output cannot override, bypass, or assert permission policy.
5. The planner proposes; a separate executor acts. These are never the same step.
6. Every side-effecting action carries an idempotency key checked before execution.
7. Untrusted lineage forces approval regardless of tier.
8. Rules and detectors operate without the model.
9. Silence is a valid successful outcome for Watch mode.
10. One agent runtime with multiple lenses, not multiple agents.
11. Retrieval combines structured and semantic signals, and prefers current facts over similar ones.
12. Autonomy is earned from evidence, and granted by the user.

## Metrics and open questions

### Metrics that mean something

**Shadow approval rate.** Of proposals surfaced, what fraction would have been approved. The one real autonomy metric, and far better than an impression that the agent seems smart.

**Retrieval hit rate.** Of questions asked, what fraction are answered correctly without re-supplying context. Measured against the frozen eval set rather than by feel.

**Nudge precision.** Of nudges surfaced, what fraction were acted on rather than dismissed. Below roughly 50% the agent is training its own user to ignore it, and the detector thresholds need tightening.

**Capture friction.** Time from opening Telegram to acknowledgment. If this exceeds a couple of seconds, capture stops happening, and everything downstream starves.

**Daily cost.** Tracked from day one, even at zero. It is the constraint most likely to be violated silently.

### Open questions

- **Stock tracking method.** Whether low-stock detection works from logging items as they run out or from receipt scanning. These diverge substantially in accuracy and effort, and the decision shapes what gets built.
- **Conflict-check cost.** One model call per fact write is correct in principle. At high capture volume it may need batching or a cheaper local first pass, with escalation only on suspected conflicts.
- **Decay curves.** The classes are defined; the actual half-lives are guesses. These need tuning against real retrieval behavior after a few weeks of data.
- **Nudge interruption threshold.** How aggressive the relevance filter should be. Better to start conservative and loosen, since an agent that cries wolf early never recovers the attention it spent.
- **Watch mode's first target.** Flight prices are an adversarial scraping problem and a poor first choice. A friendlier first watch target is still undecided.
- **Voice-note classification accuracy.** Whether a local model can reliably distinguish a fact to store from a task from a passing thought, or whether that routing needs the frontier model.

## The main risk

Not technical. Three thorough design documents now exist and no code does. The remaining unresolved questions — memory schema details, MCP boundaries, tool granularity — will not resolve through more design. They resolve in week two, from watching real data move through a real pipeline.

Milestone 0 is one evening's work and everything else in this document is a refinement of a system that already exists.
