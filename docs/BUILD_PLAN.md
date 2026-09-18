# Iris — Milestone 1→7 Build Plan

## Context

Milestone 0 (Telegram → `events` ledger, "got it.") is built and merged into PR #1 on `claude/lucid-cray-uv1dyw`. The PRD (`docs/PRD.md`) specifies seven more milestones plus cross-cutting reliability, testing, and permission requirements that are easy to build in the wrong order or drop silently (untrusted lineage, fail-closed policy gate, idempotency, decay-at-query-time, no `user_id` anywhere). This plan sequences Milestones 1–7 so that every step leaves a working system (per the PRD's own rule) and nothing in the spec gets missed. It was drafted by reading the full PRD and auditing the current repo, then validated by a planning pass; two structural calls were made where the PRD's own text creates a milestone-ordering tension:

1. **The tool registry, tiers, and policy gate move from their "natural" Milestone 6 slot to Milestone 2.** The tiers table lists `memory.forget` as tier 2, and `/forget` ships in Milestone 2 per the PRD. So a minimal registry + deterministic gate + the `actions` table (exact DDL) land in M2, gating that one tool. M6 doesn't invent this machinery — it generalizes the M2 version into the real async executor, real approval cards, and circuit breakers.
2. **Untrusted lineage is tagged at Gmail ingest (M3)**, not invented at enforcement time (M6). If Gmail-sourced events aren't marked untrusted the moment they're ingested, that lineage can't be reconstructed later.

Each milestone below reuses the existing conventions from Milestone 0/1: `recordEvent()` / `addEventMetadata()` / `markEventProcessed()` in `src/lib/events.ts` for all ledger writes, the Drizzle schema/migration flow (`src/db/schema.ts` → `npm run db:generate` → `npm run db:migrate`), and the `src/bot` / `src/db` / `src/lib` layout — new top-level dirs (`src/worker`, `src/executor`, `src/mcp`, `src/admin`, `src/eval`) are introduced only where the PRD's process model or testing requirements demand them.

New dependencies get added incrementally per milestone (pg-boss, Ollama client, a local Whisper binary wrapper, `@xenova/transformers` for embeddings, `keytar` for OS keychain, `vitest` for tests) — never all at once.

**Status:** Milestones 1, 2, and 3 are implemented and live-verified (see below). Milestones 4–7 are planned but not yet built.

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

## Milestone 2 — Memory and correction ✅ implemented and live-verified

**Scope (PRD: memories DDL, Correct flow, tiers table):** the conflict-check, decay-at-query-time, supersession, `/forget` — and, pulled forward, the tool registry/policy gate/`actions` table, since `/forget` is tier 2.

**Files:**
- `src/lib/tools/registry.ts` — `{tool, tier, handler}` map; `memory.search` (0), `memory.remember` (1), `memory.forget` (2, with a real handler wired to `executeForget`).
- `src/lib/tools/policy-gate.ts` — `evaluateAction({tool, untrusted})`, pure and deterministic: tier 0/1 → `approved`, tier 2 or untrusted → `queued`, anything it can't evaluate (unregistered tool, malformed tier) → `denied`. No model call, ever; wrapped in try/catch so any internal error fails closed instead of throwing.
- `src/lib/idempotency.ts` — `deriveIdempotencyKey(tool, args)`, a deterministic sha256 over `{tool, args}` with recursively sorted keys so key insertion order can't change the hash. Unit tested.
- `src/lib/actions.ts` — `proposeAction()` writes the `actions` row, runs the gate, and — no async executor until M6 — synchronously executes tier 0/1 approvals inline; `approveAction()`/`rejectAction()` handle the tier-2 tap. Idempotent: a second proposal with an identical tool+args returns the existing row.
- `src/lib/decay.ts` — pure `decayWeight()` for all 5 classes; `identity` never decays, `scheduled` is a hard cutoff at `valid_until`, the other three decay exponentially with a half-life that stretches with `reinforcement_count`. Unit tested (monotonicity, ordering across classes, reinforcement slowing decay, bounds).
- `src/lib/ollama.ts` — extracted shared `ollamaGenerate()` call, reused by `classifier.ts` (Milestone 1) and the two new memory modules below.
- `src/lib/memory-extraction.ts` — `extractMemoryCandidate()`: one model call producing a candidate statement/subject/predicate/object/decayClass, or `null` if nothing's worth storing. Defensively parsed (handles markdown-fenced JSON, malformed JSON, missing fields, an invalid decayClass) — never throws, always degrades to a safe default. Unit tested against a mocked model.
- `src/lib/memory.ts` — `rememberFact()`, `checkConflict()` (the one-model-call-per-write contradicts/extends/independent classification against the nearest existing memories for the same subject; skips the model call entirely when there's nothing to compare against; falls back to `independent` on any parse failure rather than risking a wrongful supersession), `supersedeMemory()`, `bumpReinforcement()`, `previewForget()`/`executeForget()`, `searchMemories()` (applies `decay.ts` at query time only, never persisted). Unit tested.
- `src/worker/jobs/extract-memory.ts` — consumes a `fact`/`correction` classification from Milestone 1's `classify.ts` (which now enqueues this job for those two labels): extracts a candidate, checks for an exact restatement (bumps reinforcement instead of duplicating), runs the conflict-check, and on `contradicts` supersedes the old memory and appends a `type: "correction"` event; on `extends`/`independent` inserts a new memory row.
- `src/bot/commands/forget.ts` — `/forget <target>` previews matches, builds a rationale, and calls `proposeAction("memory.forget", ...)` — goes through the exact same approval card as any other tier-2 action, registered ahead of the generic message handler so it isn't double-processed as ordinary capture.
- `src/admin/server.ts` — debug UI (Express), first 2 of its eventual 6 views: `/events` and `/memories` (with live decay weight computed per row).
- `vitest` added, with a setup file providing a placeholder `DATABASE_URL` so pure-logic unit tests never need a real Postgres connection. `src/lib/tools/policy-gate.test.ts` is the permission suite: tier-2 not auto-approved, tier-0/1 auto-approved, an unregistered tool denied (the "gate errors" case, since this architecture's gate is local deterministic code with no separate service to be network-unreachable), and untrusted lineage forcing the queue regardless of tier (the flag is supported now; M6 adds the lineage-walking that sets it automatically).

**Data model:** `memories` and `actions`, matching the PRD's DDL exactly (verified against the generated migration SQL), plus one added index each (`memories(subject, status)`, and the PRD's own partial index on `actions(status, tier) where status in ('proposed','approved')`, confirmed present in the generated SQL with the correct `WHERE` clause).

**Cross-cutting landed here:** tool registry/tiers/gate exist for the first time; `certainty` and `decay_class` are text columns constrained by TS union types at the application layer, never a float; decay is computed only at query time — no cron, no stored/rewritten score; no `user_id` anywhere.

**Verified:** `npm run typecheck` and `npm test` (32 tests) both pass. Live-verified end-to-end against a real bot/Postgres/Ollama: a stated preference extracted into `memories` with `certainty='asserted'`, correct `subject`/`decay_class`; a contradicting correction ("Actually my favorite coffee order is a cortado now.") correctly flipped the old memory to `status='superseded'`, inserted the new one with `supersedes` pointing at it, and logged a `type='correction'` event; `/forget` produced a real approval card, Approve executed the deletion (`actions.status='done'`), and a separate Reject left the target memory untouched (`actions.status='rejected'`, still `active`).

Two real prompt-quality bugs were found and fixed during this live verification (not caught by unit tests, since those mock the LLM call): the capture classifier needed few-shot examples to reliably label plain factual statements as `fact` rather than `conversation`, and the memory-extraction prompt needed (a) an explicit rule to use `"user"` as the subject for self-referential facts — without it, `subject` defaulted to `null` and silently disabled the conflict-check entirely — and (b) worked examples of correction-phrased input, since the model was reading "actually... now" as conversational filler and returning `null` instead of extracting the updated fact.

---

## Milestone 3 — Gmail and Calendar read-only ingest ✅ implemented and live-verified

**Scope (PRD: ingest tables, entities, secrets handling):** OAuth, history-API polling, upsert-on-provider-id, entity extraction.

**Two deliberate deviations from the plan as originally drafted, decided with the user before writing code:**

1. **Direct Google API client instead of MCP.** The PRD calls for Gmail/Calendar to go through MCP clients, on the theory of reusing existing servers and swappability. Neither benefit materializes here: there's no verified, well-maintained third-party Gmail/Calendar MCP server to point at, and building our own MCP server just so Iris can be the only client of it is pure protocol ceremony with no functional gain. Iris talks to Gmail/Calendar directly via Google's official `googleapis` client library (`src/lib/google/`) — the same "MCP is the wrong boundary" reasoning the PRD already applies to internal state (memory/events/rules) applies here too; the real MCP boundary in this codebase is simply narrower than the PRD first sketched. If a genuinely reusable Gmail/Calendar MCP server shows up later, this is the layer that would get swapped.
2. **macOS `security` CLI instead of `keytar`.** `keytar` is archived/unmaintained upstream and needs a native compile step — exactly the kind of install friction Milestone 1/2 setup already hit repeatedly (Docker ports, Node version, Ollama). Since Iris runs on an actual Mac, shelling out to the same `security` binary Keychain Access.app itself uses (`src/lib/secrets.ts`) gets the OS-keychain requirement with zero new dependencies and no native-binding risk. The PRD's own fallback note (a headless/non-macOS environment needs an encrypted-file alternative) still applies if Iris ever runs somewhere else — not implemented, since it doesn't here.

**Files:**
- `src/lib/secrets.ts` — `security add-generic-password` / `find-generic-password` / `delete-generic-password` wrapper, one service name (`iris-agent`), keyed by account.
- `src/lib/google/auth.ts` — OAuth2 client construction, refresh-token load/save via `secrets.ts`, **read-only scopes only** (`gmail.readonly`, `calendar.readonly`).
- `src/scripts/google-auth-setup.ts` — one-time interactive consent flow: binds a local loopback server on an OS-assigned port (RFC 8252 native-app flow, works with a "Desktop app" OAuth client without pre-registering the port), prints the consent URL, exchanges the code, saves the refresh token.
- `src/lib/google/gmail.ts` — `parseMessage()` (pure, unit tested) plus `getCurrentHistoryId`/`listInitialMessageIds`/`listMessageIdsSince`/`getMessage`, each request bounded to 10s.
- `src/lib/google/calendar.ts` — `parseEvent()` (pure, unit tested) plus `listInitialEvents`/`listEventsSince`, same 10s bound. `timeMin` (initial backfill) and `syncToken` (incremental) are never combined in one request — Google's API rejects that.
- `src/lib/google/errors.ts` — `classifyGoogleError()` into the PRD's six-way taxonomy, pure and unit tested; `extractHttpStatus()` exported separately so callers can detect the specific 404 (Gmail) / 410 (Calendar) "watermark expired" cases precisely rather than only the general class.
- `src/lib/sync-state.ts` — `sync_state` watermark store; `recordSyncSuccess`/`recordSyncFailure` (message only) /`resetSyncState` (clears the stored value too, for the expired-watermark case).
- `src/lib/notify.ts` — sends a Telegram message directly via the Bot API (no long-poll bot instance needed) for alerts the worker raises on its own.
- `src/lib/entities.ts` — `classifySenderType()`, a deterministic keyword/domain heuristic (not a model call, matching invariant 8's spirit even though entity classification isn't a "rule" in the M5 sense) — unit tested, upgradeable to a model call later without touching anything downstream that reads `entity.type`.
- `src/worker/jobs/ingest-gmail.ts` / `ingest-calendar.ts` — poll on a 5-minute cron (`boss.schedule`), upsert on `message_id`/`provider_id` (Gmail: `onConflictDoNothing`, since email content is immutable once fetched; Calendar: `onConflictDoUpdate`, since events genuinely change — reschedules, cancellations), tag every resulting `events` row `untrusted: true`, notify on the *transition* into an auth failure (not every poll while it stays broken), and reset the watermark on an expired historyId/syncToken rather than retrying it forever.
- `src/worker/jobs/extract-entities.ts` — enqueued per new email, links `emails.entity_id`.
- `src/admin/server.ts` — two more views: `/emails`, `/health` (sync lag + last error per source, total ingest counts).

**Data model:** `emails`, `calendar_events`, `entities`, `relations` — matching the PRD's prose description — plus `sync_state` (not named in the PRD; a plain necessity for incremental sync and restart safety, storing each source's watermark, last success time, and last error).

**Cross-cutting landed here (easiest to silently drop):** every Gmail/Calendar-sourced `events` row gets `metadata.untrusted = true` at ingest time — nothing enforces on it until M6, but it can't be reconstructed later if skipped now. The failure-classification taxonomy becomes real; `auth` failures surface to Telegram immediately rather than letting ingest go silently quiet. External calls bounded at 10s.

**Verified:** `npm run typecheck` and `npm test` (54 tests, 22 new) both pass. Live-verified end-to-end against the user's real Google account: the OAuth consent flow completed on the first try and saved the refresh token to Keychain; the initial poll backfilled 25 real emails with zero errors; real recruiting emails (SmartRecruiters, Workday, Oracle/Goldman Sachs recruiting, Two Sigma) correctly classified as `entities.type='recruiter'` via the domain/keyword heuristic, non-recruiting senders correctly left `unknown`; every Gmail-sourced `events` row confirmed tagged `untrusted: true`; a forced redundant poll cycle left the email count at exactly 25 — no duplicates, confirming the upsert-on-`message_id` idempotency; Calendar ingest ran with zero errors and correctly returned 0 events, matching the user's actually-empty calendar (confirmed against the real Google Calendar UI, not assumed).

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
| MCP boundary limited to Gmail/Calendar/web search | Revised at M3 — no MCP used at all (direct Google API client instead, see M3's write-up); reassess if web research (M7+) turns out to have a real MCP server worth using |

## Invariants tracking

The 12 invariants aren't a separate milestone — they're satisfied incrementally (7 at M3/M6, 5 & 6 at M2/M6/M7, 8 & 9 at M5, 12 at M7, etc.) and should be re-checked as a checklist at the end of every milestone, not just once at the end.

## Overall verification

Each milestone section above has its own concrete test. The two checkpoints that matter most across the whole plan: the definition-of-done question must resolve correctly once M4 ships on top of M3+M1/M2 data (M4 verification), and the permission test suite must stay green on every commit from M2 onward — a regression there is called out in the PRD as the one class of bug able to do real damage.

## Next step

Milestone 4 — unified search (embeddings, hybrid retrieval, the ranking rule, the definition-of-done question). With real email and memory data now flowing (Milestones 1–3 all live-verified), this is the milestone where the PRD's own cold-start test question — "who was the recruiter... what did I decide about the rate" — first becomes answerable.
