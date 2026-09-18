# Iris — Milestone 1→7 Build Plan

## Context

Milestone 0 (Telegram → `events` ledger, "got it.") is built and merged into PR #1 on `claude/lucid-cray-uv1dyw`. The PRD (`docs/PRD.md`) specifies seven more milestones plus cross-cutting reliability, testing, and permission requirements that are easy to build in the wrong order or drop silently (untrusted lineage, fail-closed policy gate, idempotency, decay-at-query-time, no `user_id` anywhere). This plan sequences Milestones 1–7 so that every step leaves a working system (per the PRD's own rule) and nothing in the spec gets missed. It was drafted by reading the full PRD and auditing the current repo, then validated by a planning pass; two structural calls were made where the PRD's own text creates a milestone-ordering tension:

1. **The tool registry, tiers, and policy gate move from their "natural" Milestone 6 slot to Milestone 2.** The tiers table lists `memory.forget` as tier 2, and `/forget` ships in Milestone 2 per the PRD. So a minimal registry + deterministic gate + the `actions` table (exact DDL) land in M2, gating that one tool. M6 doesn't invent this machinery — it generalizes the M2 version into the real async executor, real approval cards, and circuit breakers.
2. **Untrusted lineage is tagged at Gmail ingest (M3)**, not invented at enforcement time (M6). If Gmail-sourced events aren't marked untrusted the moment they're ingested, that lineage can't be reconstructed later.

Each milestone below reuses the existing conventions from Milestone 0/1: `recordEvent()` / `addEventMetadata()` / `markEventProcessed()` in `src/lib/events.ts` for all ledger writes, the Drizzle schema/migration flow (`src/db/schema.ts` → `npm run db:generate` → `npm run db:migrate`), and the `src/bot` / `src/db` / `src/lib` layout — new top-level dirs (`src/worker`, `src/executor`, `src/mcp`, `src/admin`, `src/eval`) are introduced only where the PRD's process model or testing requirements demand them.

New dependencies get added incrementally per milestone (pg-boss, Ollama client, a local Whisper binary wrapper, `@xenova/transformers` for embeddings, `keytar` for OS keychain, `vitest` for tests) — never all at once.

**Status:** Milestone 1 is implemented (see below). Milestones 2–7 are planned but not yet built.

---

## Milestone 1 — Capture proper ✅ implemented

**Scope (PRD: Capture flow + Processes):** voice notes via local Whisper, forwarded messages/files, a Telegram supergroup with topics (capture/approvals/brief), and background classification decoupled from the instant "got it." This is the milestone that forces the Bot/Worker process split into existence.

**Files:**
- `src/bot/topics.ts` — resolves capture/approvals/brief topic IDs from env (optional; falls back to a plain chat).
- `src/lib/storage.ts` — downloads Telegram files/voice/photos to local disk.
- `src/lib/whisper.ts` — shells out to a local whisper.cpp-compatible CLI for transcription.
- `src/lib/classifier.ts` — calls a local Ollama model to label text as fact/task/reminder/correction/conversation.
- `src/lib/queue.ts` — pg-boss client shared by bot (enqueue) and worker (consume); creates the `transcribe`/`classify` queues on start.
- `src/worker/index.ts` — second process entry point (`npm run dev:worker`).
- `src/worker/jobs/transcribe.ts` — Whisper job; appends a new `events` row (`type: "transcript"`) referencing the source event, then enqueues classification for the transcript — never mutates the original voice event.
- `src/worker/jobs/classify.ts` — labels an event into `events.metadata.label` via `markEventProcessed()`.
- `src/bot/index.ts` — branches on message shape (voice/audio/document/photo/text), keeps `recordEvent()` + instant "got it." synchronous, downloads/enqueues background work after replying.
- `src/lib/events.ts` — added `getEvent()`, `addEventMetadata()` (metadata patch without marking processed), `markEventProcessed()` (patch + `processed_at`).

**Data model:** none — `events.raw_data`/`metadata` (already JSONB) cover files, voice, and labels.

**Cross-cutting landed here:** first Bot/Worker process boundary; pg-boss gives restart-safety via Postgres-backed jobs; a `trace_id` (UUID) is generated per inbound message and threaded through `events.metadata` and job payloads so nothing needs retrofitting later.

**Verification:** text → sub-second "got it." (this is the Capture Friction metric — measure it); voice note → instant ack, then a transcript event once the job runs; forwarded message and a file both land in `events` with correct provenance and the file exists on disk; kill/restart the worker mid-transcription — pg-boss should not duplicate or lose the job.

**Setup needed to exercise it:** a whisper.cpp-compatible binary + model (`WHISPER_BINARY_PATH` / `WHISPER_MODEL_PATH`), and a local Ollama instance with a pulled model (`OLLAMA_HOST` / `OLLAMA_MODEL`). See the root `README.md`.

---

## Milestone 2 — Memory and correction

**Scope (PRD: memories DDL, Correct flow, tiers table):** the conflict-check, decay-at-query-time, supersession, `/forget` — and, pulled forward, the tool registry/policy gate/`actions` table, since `/forget` is tier 2.

**New files:**
- `src/lib/tools/registry.ts` — `{tool, tier, handler}` map; seed `memory.search` (0), `memory.remember` (1), `memory.forget` (2).
- `src/lib/tools/policy-gate.ts` — pure, deterministic: tier 0/1 auto-approve, tier 2 queue, **gate unreachable/error → deny**. No model call in this file, ever.
- `src/lib/idempotency.ts` — `deriveIdempotencyKey(tool, args)`, unit tested now.
- `src/lib/actions.ts` — `proposeAction()`: writes the `actions` row, runs the gate, and — no async executor yet — synchronously executes tier 0/1 and posts an inline approve/reject message to the approvals topic for tier 2, executing on tap. Comment it clearly as a throwaway stand-in that M6's executor replaces.
- `src/lib/decay.ts` — pure `decayWeight(decayClass, lastConfirmedAt, now)` for `identity`/`employment`/`preference`/`intent`/`scheduled`. Unit tested.
- `src/lib/memory.ts` — `rememberFact()`, `conflictCheck()` (one model call classifying contradicts/extends/independent against nearest existing memories), `supersede()`, `searchMemories()` (applies `decay.ts` at query time only, never persisted).
- `src/worker/jobs/extract-memory.ts` — consumes M1's classify output; on `contradicts`, supersede + append a `type: "correction"` event; on `extends`, insert independently (no supersession).
- `src/bot/commands/forget.ts` — `/forget <target>` → `proposeAction("memory.forget", ...)`, goes through the same approval card as any other tier-2 action — no bypass for being a slash command.
- `src/admin/server.ts`, `src/admin/views/events.ts`, `src/admin/views/memories.ts` — debug UI scaffold, first 2 of its eventual 6 views.
- `vitest` added; `src/lib/policy-gate.test.ts` — first 3 permission-suite cases: `memory.forget` DENY without approval, `memory.search` ALLOW, gate-unreachable → DENY.

**Data model:** add `memories` and `actions`, using the PRD's exact DDL (including the `vector(384)` column on `memories` via a Drizzle `customType`, and the partial index `on actions (status, tier) where status in ('proposed','approved')`).

**Cross-cutting landed here:** tool registry/tiers/gate exist for the first time; `certainty` is an ordinal 3-value field (`asserted`/`inferred`/`contradicted`) enforced in the schema type, never a float; decay is computed only at query time — no cron, no stored/rewritten score; no `user_id` anywhere.

**Verification:** state a fact → `memories` row with correct certainty/decay_class via the debug UI; contradict it → conflict-check fires, old row `superseded`, new row's `supersedes` set, correction event appended; `/forget` → approval card appears, Reject leaves data untouched, Approve hard-deletes and records `status='done'`; `vitest` green on the 3 current permission cases.

---

## Milestone 3 — Gmail and Calendar read-only ingest

**Scope (PRD: ingest tables, entities, secrets handling):** OAuth, history-API polling, upsert-on-provider-id, entity extraction. Note: any `mcp__Gmail__*`-style tools available to an AI assistant session are not Iris's — Iris needs its own OAuth app and its own MCP client/server running in its own process.

**New files:**
- `src/lib/secrets.ts` — OS keychain wrapper (`keytar`). Flag now: if Iris runs headless/containerized rather than on an actual desktop, there may be no Secret Service daemon — document an encrypted-local-file fallback (never `.env`) for that case.
- `src/lib/google-auth.ts` + `src/scripts/google-auth-setup.ts` — one-time local OAuth consent, **read-only scopes only**, tokens → keychain.
- `src/mcp/gmail-client.ts`, `src/mcp/calendar-client.ts` — the PRD's one correct use of MCP (third-party integration boundary); don't let this pattern spread to memory/events/rules.
- `src/worker/jobs/ingest-gmail.ts` — polls Gmail History API using a stored `historyId` watermark, upserts into `emails` on `message_id` conflict.
- `src/worker/jobs/ingest-calendar.ts` — Calendar incremental sync (`syncToken`), upserts into `calendar_events` on `provider_id` conflict.
- `src/worker/jobs/extract-entities.ts` — classifies sender category (e.g. `recruiter`) into `entities`.

**Data model (PRD gives prose, not DDL — inferred to match stated constraints):**
- `emails(id uuid pk, message_id text unique not null, thread_id text, from_address text, from_name text, to_addresses jsonb, subject text, snippet text, body_text text, labels jsonb, entity_id uuid references entities(id), received_at timestamptz, raw jsonb, created_at timestamptz default now())`
- `calendar_events(id uuid pk, provider_id text unique not null, calendar_id text, title text, description text, location text, start_at timestamptz, end_at timestamptz, all_day boolean, attendees jsonb, status text, updated_at timestamptz, raw jsonb, created_at timestamptz default now())`
- `entities(id uuid pk, name text not null, type text not null, aliases jsonb, metadata jsonb, created_at timestamptz default now())`
- `relations(id uuid pk, from_entity_id uuid references entities(id), to_entity_id uuid references entities(id), relation_type text, metadata jsonb, created_at timestamptz default now())`

**Cross-cutting landed here (easiest to silently drop):** every Gmail-sourced `events` row gets `metadata.untrusted = true` at ingest time — nothing enforces on it until M6, but it can't be reconstructed later if skipped now. Also: the failure-classification taxonomy (`retryable`/`auth`/`rate_limit`/`invalid_input`/`provider_failure`/`internal_failure`) becomes real — `auth` failures must surface to Telegram immediately, not fail silently; external calls bounded at 10s. Debug UI gains partial system health (Gmail/Calendar sync lag).

**Verification:** OAuth setup once, tokens confirmed in keychain not `.env`; first poll backfills both tables, a forced redundant poll produces zero duplicate rows; manually revoke the token and confirm an immediate auth-failure notice instead of silent quiet; a real recruiter email produces an `entities` row with `type='recruiter'`.

---

## Milestone 4 — Unified search

**Scope (PRD: embeddings, hybrid retrieval, ranking rule, definition-of-done):** this is where the MVP's cold-start test question first becomes answerable — "who was the recruiter... what did I decide about the rate."

**New files:**
- `src/lib/embeddings.ts` — local embedding model (bge-small/all-MiniLM via `@xenova/transformers`), zero-cost.
- `src/worker/jobs/embed.ts` — chunks + embeds new/updated messages and emails into the `embeddings` table.
- `src/lib/retrieval.ts` — four legs merged: semantic (pgvector `<=>` over `embeddings` + `memories.embedding`), structured SQL over `emails`/`calendar_events`, `memories.ts` search filtered to active/non-superseded, recent `events` for conversational context — plus the PRD's explicit ranking rule: **prefer the newest non-superseded fact over the most semantically similar one.**
- `src/lib/ask.ts` — Ask flow entry point. Retrieved content goes into a typed data field passed to the model, never concatenated into the instruction string (first real use of the "structural separation" injection defense, established early even though nothing acts on model output yet).
- `src/eval/` — new directory; start the labeled eval set now (PRD wants 50–100 scenarios "before Milestone 4 ships," meaning work starts during M3).

**Modify:** `src/bot/index.ts` — route free-form questions to `ask.ts`.

**Data model:** `embeddings(id uuid pk, source_table text not null, source_id uuid not null, chunk_index int not null default 0, content text, vector vector(384) not null, created_at timestamptz default now())`, unique on `(source_table, source_id, chunk_index)`. `memories` keeps using its own `embedding` column directly — don't duplicate memory vectors into this table too.

**Verification (load-bearing):** build a real script in `src/eval/` reproducing the definition-of-done question from a cold process with no context in the prompt, using a real recruiter email (M3) plus a Telegram-captured rate decision (M1/M2) — this becomes eval case #1. Also run retrieval-ranking unit tests confirming decay+supersession beats raw cosine similarity.

---

## Milestone 5 — Rules engine and nudges

**Scope (PRD: nudges DDL, three named detectors, cooldown/backoff, morning brief):**

**New files:**
- `src/worker/jobs/run-detectors.ts` — cron, runs each enabled rule's SQL, logs to `rule_runs`.
- `src/lib/rules/detectors/recruiter-follow-up.ts`, `upcoming-interview.ts`, `unanswered-important-email.ts` — deterministic SQL only (invariant 8: rules operate without the model).
- `src/worker/jobs/relevance-filter.ts` — **one** model call per detector run reviewing the whole candidate batch, picking 0–3 — not one call per candidate.
- `src/lib/nudges.ts` — cooldown/backoff logic on top of the unique partial index, addressing the "fires every morning for six days" failure mode directly.
- `src/worker/jobs/morning-brief.ts` — scheduled post to the brief topic; sends nothing on a quiet day (invariant 9: silence is a valid success, never force a message to prove liveness).

**Data model:** `nudges` exactly per PRD DDL (including the unique partial index on `(rule_id, entity_id) where dismissed = false`); `rules(id uuid pk, name text, description text, sql_definition text, importance_weight numeric, enabled boolean default true, created_at timestamptz default now())`; `rule_runs(id uuid pk, rule_id references rules(id), ran_at timestamptz default now(), candidate_count int, error text)` — inferred, needed for the debug UI's rule-run-history view.

**Cross-cutting:** debug UI gains rule run history, active watches, and completes system health (worker liveness, queue depth via pg-boss, last scheduler run).

**Verification:** seed fixtures triggering all three named detectors; confirm `rule_runs` logs each pass and the relevance filter selects correctly; re-run the same pass — no duplicate nudge, no same-day re-notification; dismiss a nudge — it doesn't reappear; a day with nothing to surface produces genuine silence.

---

## Milestone 6 — Action ledger and shadow mode (generalization, not birth)

**Scope:** generalizes M2's synchronous stand-in into the real architecture — separate Executor process, real approval cards, circuit breakers, the remaining permission-suite cases.

**New files:**
- `src/executor/index.ts` — third standalone process; polls `actions` where `status='approved'`, executes via the registry, writes `result`/`status='done'`/`executed_at`; reconciles rows stuck in `executing` at startup (restart-safety invariant).
- `src/lib/telegram-cards.ts` — real approval cards (tool, args, rationale, tier, source snippet) replacing M2's throwaway inline confirm.
- `src/lib/untrusted-lineage.ts` — walks `source_event_id` back through the chain; if untrusted content (tagged in M3) fed the proposal, forces `untrusted=true` regardless of tool tier (invariant 7).

**Modify:** `src/lib/tools/policy-gate.ts` — extend with tier-2 auto-approval by predicate (contacts allowlist, thread-exists, daily send cap — largely dormant until M7's send tools exist, but the gate must support the path now); circuit breakers (tier-2/hour cap, daily token budget, failure-rate halt); a kill-switch flag draining everything to the queue.

**Tests:** complete the permission suite — forged/model-supplied approval token → DENY; tier-1 proposal with untrusted lineage → QUEUE. Wire the full suite into CI.

**Debug UI:** sixth and final view — tool call audit over `actions` (tier, status, rationale, lineage, undo availability).

**Sequencing note:** by M6 the only tier-2 tool in existence is `memory.forget` from M2 — thin material for "a month of data collection." Accept a thin M6 dataset rather than pulling M7 tools forward; real volume starts once M7's `gmail.send_draft`/`calendar.create_event` land, each then needing its own ~30-proposal runway before promotion is considered.

**Verification:** every tier-2 proposal produces a real card; approve/reject taps correctly update `decided_at`/`status`; kill the executor mid-run and restart — no re-execution of a done action, no loss of a pending one; full permission suite green in CI.

---

## Milestone 7 — First write actions

**Scope (PRD: write tools, egress allowlists, idempotency's hard case, undo, autonomy ladder):**

**New files:**
- `src/lib/tools/gmail-write.ts` — `gmail.create_draft(thread_id, body)` tier 1 auto; `gmail.send_draft(draft_id)` tier 2 approval. Needs an OAuth scope upgrade from M3's read-only scopes.
- `src/lib/tools/calendar-write.ts` — `calendar.create_event(...)` tier 2 approval.
- `src/lib/contacts-allowlist.ts` — built from prior correspondence in `emails`, feeds M6's predicate auto-approval.
- Egress allowlist enforcement **inside the executor itself** (structural, not just a policy-gate check — injection cannot argue its way past code that never consults it).
- `src/lib/undo.ts` — populate `undo_payload` at proposal time, finalize post-execution.
- Idempotency, the hard case: DB-level `idempotency_key` uniqueness prevents a duplicate proposal row; the crash-between-successful-send-and-status-write case additionally needs reconciliation (e.g. search Gmail for evidence the message already sent) before ever retrying on restart — give this its own dedicated test.
- `src/lib/autonomy.ts` — the ladder: at ≥30 decisions and ~95% approval, proactively offer "make it automatic?" (never self-promote); symmetric demotion on a rejection-rate threshold. New table `tool_autonomy_overrides(tool text primary key, level int, updated_at timestamptz)`, consulted by the policy gate ahead of the static tier default.

**Verification:** draft a real email (auto tier 1, appears in Gmail); propose sending (tier 2, queued, card); approve → exactly-once send; simulate a crash between the successful Gmail call and the DB commit, restart → no resend; an out-of-allowlist recipient is refused at the executor even under a forced test approval; run the full frozen eval set + permission suite as a gate before/after any future prompt change.

**Then, explicitly out of MVP scope (noted for continuity only):** career lens as a config object (`/career` toggles instructions/tool-subset/memory-scope, same runtime — "lenses, not sub-agents"), web research (new MCP client, isolated browsing profile), document/PDF ingestion (feeds M4's embeddings pipeline). Reservations, finances, health, and a dashboard stay fully out of scope.

---

## Debug UI rollout (incremental, not a big-bang build)

| Milestone | Views added |
|---|---|
| M2 | recent events, memory search/inspection |
| M3 | + Gmail/Calendar sync lag (system health, partial) |
| M5 | + rule run history, active watches, system health completed |
| M6 | + tool call audit (final view, 6/6) |

## Permission test suite rollout

| Milestone | Cases added |
|---|---|
| M2 | `memory.forget` DENY without approval; `memory.search` ALLOW; gate-unreachable → DENY |
| M6 | forged/model-supplied approval token → DENY; tier-1 + untrusted lineage → QUEUE |
| M7 | new tool-specific cases (`gmail.send_draft` DENY without approval, egress allowlist enforcement) |

## Cross-cutting requirements — where each lands

| Requirement | Lands at |
|---|---|
| Tool registry + tiers + policy gate | M2 (pulled forward from M6) |
| Idempotency keys | M2 (derivation) → M6 (checked in executor) → M7 (hard exactly-once case) |
| Fail-closed gate | M2 |
| `trace_id` / observability | M1 (seeded) → M4 (full retrieval chain) → M6 (action lifecycle) |
| Secrets in OS keychain | M3 |
| Untrusted lineage tagged / enforced | M3 (tagged) → M6 (enforced) |
| Egress allowlists at executor | M7 |
| Idempotency check + result in one transaction | M6 (plumbing) → M7 (real reconciliation case) |
| Cooldown/backoff on nudges | M5 |
| Decay at query time, never stored | M2 |
| Certainty as ordinal, not float | M2 |
| No `user_id` / no `users` table | Every migration — treat as a standing check |
| MCP boundary limited to Gmail/Calendar/web search | M3 |

## Invariants tracking

The 12 invariants aren't a separate milestone — they're satisfied incrementally (7 at M3/M6, 5 & 6 at M2/M6/M7, 8 & 9 at M5, 12 at M7, etc.) and should be re-checked as a checklist at the end of every milestone, not just once at the end.

## Overall verification

Each milestone section above has its own concrete test. The two checkpoints that matter most across the whole plan: the definition-of-done question must resolve correctly once M4 ships on top of M3+M1/M2 data (M4 verification), and the permission test suite must stay green on every commit from M2 onward — a regression there is called out in the PRD as the one class of bug able to do real damage.

## Next step

Milestone 2 — memory and correction, plus the tool registry/policy gate/`actions` table it pulls forward from M6.
