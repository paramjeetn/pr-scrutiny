# PR Scrutiny — Progress

Last updated: 2026-06-17
Status: **Phases 1–8 complete** (Milestone 1–3 done). Phase 9–10 (Firestore + Deploy) not started.

---

## What Is Done

### Phase 1 — Types + Fixture System
**Code**
- `src/types/index.ts` — all shared types: `ReviewJob`, `FileDiff`, `Finding`, `AgentResult`, `AgentTrace`, `JobTrace`, `Command`, `Severity`, `LLMProvider`, `PROVIDER_MODELS` (current model IDs)
- `src/fixtures/loader.ts` — reads a fixture folder → produces a valid `ReviewJob`
- `tests/fixtures-data/pr-001-hardcoded-secret/` — realistic fixture with hardcoded secrets, SQL injection, eval, N+1, no-auth routes, related files, repo tree

**Tests** (`tests/fixtures/loader.test.ts`, 16 tests)
- ReviewJob shape validation, UUID uniqueness, PR fields, diff parsing, file counts, option overrides, repo_config defaults

---

### Phase 2 — Security Agent
**Code** (`src/agents/security/`)
- `secrets.ts` — regex patterns for Stripe, AWS, GCP, generic passwords + entropy heuristic for high-entropy strings; skips test/fixture/mock files
- `injection.ts` — eval() with non-literal arg, raw SQL string concat, shell injection sinks (exec/execSync/spawn)
- `auth.ts` — unprotected routes (Express routes without middleware), JWT verify without expiry check
- `dependencies.ts` — OSV.dev API lookup for known CVEs in package.json dependencies; uses in-memory CVE cache
- `index.ts` — runs all 4 passes, aggregates findings, returns `AgentResult` with trace

**Tests** (`tests/security/security-agent.test.ts`, 44 tests)
- Stripe live key (HOLD), AWS key ID (HOLD), hardcoded password (HOLD), entropy WARN, clean code = zero findings, skip test files
- eval() HOLD, SQL concat HOLD
- Full run: valid shape, finds issues on fixture, all HOLD findings on fixture, clean job = no HOLD, trace duration positive

---

### Phase 3 — Quality Agent
**Code** (`src/agents/quality/`)
- `logic.ts` — off-by-one (`<= .length`), unreachable code after return, always-false conditions
- `complexity.ts` — cyclomatic complexity scorer; WARN ≥ 21, SUGGEST 11–20
- `test-coverage.ts` — new functions with no paired test file → SUGGEST
- `performance.ts` — N+1 (DB call inside loop), blocking I/O (`readFileSync` in async fn), `while(true)` with no break
- `index.ts` — routes by command (`review:perf` runs only performance pass, `review` runs all 4)

**Tests** (`tests/quality/quality-agent.test.ts`, 24 tests)
- Off-by-one, unreachable code, always-false, clean = zero
- High complexity WARN + remediation, simple = zero, moderate SUGGEST
- New function no test file SUGGEST, test file exists = no finding, skips test files themselves
- N+1 on fixture WARN, N+1 points to db.js, readFileSync in async WARN, clean = zero, while(true) WARN
- Full run: valid shape, finds issues on fixture, review:perf only runs perf pass, all findings have severity+message

---

### Phase 4 — Blast Radius Agent
**Code** (`src/agents/blast-radius/`)
- `parser.ts` — extracts `require()` and ES `import` paths from file content; resolves relative paths
- `graph.ts` — `resolveInTree()` (exact match + extension fallback); `buildImportGraph()` (1-hop reverse: who imports the changed file)
- `classify.ts` — config change detection (env/config/settings filenames), migration file detection, route file detection, missing test files
- `index.ts` — runs graph traversal + classifiers, returns affected files list + `BlastRadiusMetadata`

**Tests** (`tests/blast-radius/blast-radius.test.ts`, 17 tests)
- require() extraction, ES import extraction, path resolution, non-relative imports ignored
- `resolveInTree`: exact match, add extension, null for unresolvable
- Graph: finds all direct importers of db.js, changed files always in affected set, large repo tree under 2s
- Classifier: config change, missing test file, has test file = no finding, route detection, migration detection
- Full run: valid shape, BlastRadiusMetadata shape, affected_files includes changed, detects config change, flags missing tests, all findings valid, trace duration non-negative

---

### Phase 5 — LLM Agent (Vercel AI SDK)
**Code** (`src/agents/llm/`)
- `summary.ts` — `generateText()` → structured JSON `{summary, risk, why}`; maps risk→severity (low→PASS, medium→SUGGEST, high→WARN); produces `**Summary:**` finding + `**Why:**` line
- `questions.ts` — `generateText()` → JSON array of 2–4 clarifying questions; fallback extracts `?` lines from non-JSON response
- `ask.ts` — conversational answer for `/ask` command; wraps in PASS finding as `**Q:** ... **A:** ...`
- `index.ts` — routes by command (`ask`→runAskPass, `summarize/review`→summary+questions in parallel); accepts optional `_modelOverride` for testing; graceful error handling (returns empty findings, no throw)

Providers: Vercel AI SDK v6 — `createOpenAI`, `createAnthropic`, `createGoogleGenerativeAI`
Token counting: `(usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)` (SDK v6 field names)

**Tests** (`tests/llm/llm-agent.test.ts`, 17 unit tests — mock model, zero API calls)
- Mock model: `specificationVersion: 'v2'`, `doGenerate` returns `content: [{type:'text', text}]`, `usage: {inputTokens, outputTokens, totalTokens}`
- SummaryPass: valid JSON parse, malformed JSON fallback, risk=low→PASS, risk=medium→SUGGEST
- QuestionsPass: JSON array parse, non-JSON fallback extracts `?` lines, empty array = zero findings
- AskPass: wraps in PASS finding, uses default question when none provided
- Full run: valid AgentResult shape, graceful model error, ask=single PASS, review=summary+questions, all findings valid, metadata.tokens_used is number, trace duration non-negative

**Integration tests** (`tests/llm/llm-agent.integration.test.ts`, 2 tests — real OpenAI gpt-4o-mini)
- `summarize`: returns summary finding + question findings (~2000 tokens)
- `ask`: answers specific question about diff (~800 tokens)
- Skipped when `OPENAI_API_KEY` not set

---

### Phase 6 — Orchestrator + Formatter + CLI
**Code** (`src/orchestrator/`)
- `router.ts` — maps `Command` → `AgentName[]`; `review/re-review` = all 4, `review:security` = Security only, `review:perf` = Quality only, `summarize/ask` = LLM only, `blast-radius` = BlastRadius only
- `dispatcher.ts` — `Promise.race` per agent with per-agent timeout (Security/Quality/BlastRadius: 30s, LLM: 60s); `Promise.allSettled` across all agents; partial results on timeout; `timed_out` flag in trace
- `aggregator.ts` — dedup by `file:line` key (highest severity wins, same severity keeps first); sort HOLD→WARN→SUGGEST→PASS→QUESTION; builds `JobTrace` with `llm_tokens_used` from LLMAgent metadata
- `formatter.ts` — splits findings into inline (has file+line) vs top-level; groups by severity; sections: header → AI Summary (prose block, top) → HOLD → WARN → SUGGEST → PASS → Questions (with "Raised by AI" label) → inline note → collapsed trace (human-readable agent names: Security/Quality/AI/Blast Radius)
- `index.ts` — `runOrchestrator(job)` → `OrchestratorResult { review: FormattedReview, trace: JobTrace }`

**CLI** (`src/cli.ts`) — `npx tsx src/cli.ts <command> <fixture-dir> [question]`; reads `.env`; prints summary + inline count

**Tests** (`tests/orchestrator/orchestrator.test.ts`, 25 tests)
- Router: all 7 commands map to correct agent sets
- Aggregator: merges findings, dedup by file+line (highest severity wins, same severity = first), findings without file/line not deduped, sort order, trace includes all agents, llm_tokens_used from LLMAgent metadata
- Formatter: inline vs top-level split, HOLD block present, clean status, questions section, collapsed details block with "Analysis details" label, inline body has remediation
- Orchestrator full run (review:security on fixture): valid OrchestratorResult shape, finds HOLD, summary contains `## PR Scrutiny`, total_findings >= inline count
- Orchestrator blast-radius: runs BlastRadiusAgent only, summary mentions affected files/config
- Timeout handling: timed-out agent → empty findings, `timed_out=true` in trace

---

### Phase 7 — Hono Server + Webhooks
**Code** (`src/server.ts`, `src/webhook/`)
- `server.ts` — Hono app; `GET /health` → `{status:'ok'}`; `POST /webhook`; reads `GITHUB_WEBHOOK_SECRET`
- `hmac.ts` — `verifySignature()` HMAC-SHA256; `timingSafeEqual` prevents timing attacks; handles buffer length mismatch
- `parser.ts` — `parseSlashCommand()` extracts command+question from comment body (`/review`, `/review:security`, `/review:perf`, `/ask <q>`, `/summarize`, `/blast-radius`, `/re-review`); `parseWebhookContext()` extracts installationId, repo, prNumber, headSha per event type (`issue_comment` / `pull_request` / `pull_request_review`)
- `idempotency.ts` — in-memory Sets for delivery dedup (X-GitHub-Delivery) and active job tracking (repo:pr:sha); exports `_reset()` for tests
- `handler.ts` — full pipeline: HMAC → ping → delivery dedup → parse context → resolve token → return 200 immediately → `setImmediate` async processJob → assembleContext → runOrchestrator → postReview

**Tests** (`tests/webhook/webhook.test.ts`, 29 tests)
- HMAC: valid signature accepted, wrong sig rejected, missing sig rejected, tampered body rejected
- parseSlashCommand: all 7 commands, `/ask` with/without question, unknown command = null, non-slash = null, trailing whitespace ignored
- parseWebhookContext: `issue_comment` on PR, `issue_comment` on plain issue (prNumber null), `pull_request` opened, unrecognized event = unknown, ping event
- Handler: GET→404, ping→200 pong, invalid HMAC→401, valid HMAC→202 accepted, duplicate delivery→skipped, unhandled event→skipped, non-slash comment→skipped, `/review` command→queued, `pull_request` opened→queued, duplicate job (same repo+pr+sha)→skipped, malformed JSON→400

---

### Phase 8 — GitHub Integration
**Code** (`src/github/`)
- `auth.ts` — `createAppJWT(appId, privateKey)` RS256 signing; `getInstallationToken()` exchanges JWT for installation access token via GitHub API
- `context.ts` — `assembleContext()`: fetches PR metadata (title, body, head SHA, base SHA, author), diff files (capped at 25, security-sensitive paths prioritized when capping), file contents, repo tree (recursive git tree), 1-hop related files (imports, capped at 10), dependency manifest (package.json/requirements.txt/go.mod/Cargo.toml/pom.xml/Gemfile), existing PR comments, `.pr-scrutiny.yml` config, commit messages → `ReviewJob`
- `poster.ts` — `CommentPoster` class:
  - `postProvisional(prNumber)` → posts "Analysis in progress..." comment, returns commentId
  - `deleteComment(id)` → silent fail (non-fatal)
  - `postSummary(prNumber, body)` → posts top-level markdown comment, returns commentId
  - `postInlineReview(prNumber, sha, comments)` → batched `POST /pulls/{id}/reviews` with `event: 'COMMENT'`; skipped when no inline comments
  - `postReview(prNumber, sha, review)` → full flow: provisional → inline review → summary → delete provisional; inline failure does not block summary

**Tests**
- `tests/github/context.test.ts` (10 unit tests, mocked Octokit)
  - Valid ReviewJob shape, diff maps to FileDiff, file content fetched, repo tree included, commit messages included, caps at 25 files, prioritizes security-sensitive files, git tree failure graceful, question passed for /ask, throws on invalid repo format
- `tests/github/poster.test.ts` (10 unit tests, mocked Octokit)
  - Invalid repo format throws, postProvisional returns ID, deleteComment calls API, deleteComment failure silent, postSummary returns ID, postInlineReview calls createReview, postInlineReview skipped when no comments, postReview full flow order, inline failure doesn't block summary, no inline = skips createReview

**Integration tests** (`tests/github/github.integration.test.ts`, 3 tests — real GitHub API, real repo)
- Repo: `paramjeetn/pr-scrutiny-test-repo`
- `assembles ReviewJob from real GitHub PR` — PR #1; checks diff.length > 0, repo_tree populated, changed_files populated
- `runs security agent on real PR diff` — PR #1 review:security; summary contains `## PR Scrutiny`, SecurityAgent ran, timed_out=false
- `posts real review comment to PR #1 (blast-radius only)` — posts summary to PR #1, returns commentId > 0
- Skipped when `GITHUB_TOKEN` or `OPENAI_API_KEY` not set

**Full pipeline integration tests** (`tests/github/full-pipeline.integration.test.ts`, 5 tests — real GitHub API + real OpenAI)
- PR #3 (payment-service) — `review:security`: SecurityAgent finds HOLD secrets + injection, summary contains HOLD/blocking
- PR #4 (order-service) — `review:perf`: QualityAgent finds N+1 + blocking I/O, finding_count > 0
- PR #5 (db-migration) — `blast-radius`: BlastRadiusAgent detects migration + config changes, summary mentions "migration"
- PR #6 (notifications) — `summarize`: LLMAgent produces AI summary of clean code, no error, llm_tokens_used > 0
- PR #3 combined — `review:security` + BlastRadiusAgent together (tests orchestrator parallelism): total_findings > 0
- All 5 post real review comments to the test repo PRs
- Skipped when `GITHUB_TOKEN` or `OPENAI_API_KEY` not set

---

## Test Count Summary

| File | Tests | Type |
|---|---|---|
| `tests/fixtures/loader.test.ts` | 16 | unit |
| `tests/security/security-agent.test.ts` | 44 | unit |
| `tests/quality/quality-agent.test.ts` | 24 | unit |
| `tests/blast-radius/blast-radius.test.ts` | 17 | unit |
| `tests/llm/llm-agent.test.ts` | 17 | unit (mock model) |
| `tests/orchestrator/orchestrator.test.ts` | 25 | unit |
| `tests/webhook/webhook.test.ts` | 29 | unit |
| `tests/github/context.test.ts` | 10 | unit (mocked Octokit) |
| `tests/github/poster.test.ts` | 10 | unit (mocked Octokit) |
| `tests/llm/llm-agent.integration.test.ts` | 2 | integration (real OpenAI) |
| `tests/github/github.integration.test.ts` | 3 | integration (real GitHub) |
| `tests/github/full-pipeline.integration.test.ts` | 5 | integration (real GitHub + OpenAI) |
| **Total** | **202** | |

Unit tests: 192 (no network, no API keys needed)
Integration tests: 10 (skipped in CI, opt-in via `.env`)
Current passing: **190/190** (integration tests ran and passed locally)

---

## What Is Left

### Phase 9 — Firestore Storage + Installation Config
- `Firestore` collections: `installations/{id}` (API key KMS-encrypted, provider, email), `jobs/{repo}:{pr}:{sha}` (status, findings, trace, 4h TTL), `idempotency/{delivery_id}` (24h TTL), `cve_cache/{pkg}:{version}` (6h TTL)
- Replace in-memory idempotency (`src/webhook/idempotency.ts`) with Firestore reads/writes
- Replace `GITHUB_TOKEN` env var with Firestore installation lookup + KMS decrypt
- Setup page: user pastes API key → stored encrypted in Firestore
- `.pr-scrutiny.yml` already read in context assembler; Firestore stores per-repo overrides

### Phase 10 — E2E + Deploy to Cloud Run
- Cloud Build trigger on push to `main`
- Dockerfile / container config
- Cloud Run service with env vars wired to Secret Manager
- GitHub App registration (production) with correct webhook URL
- E2E smoke test: real webhook → Cloud Run → real PR comment
- GCP services: Cloud Run, Firestore, Secret Manager, KMS, Cloud Logging, Cloud Build

---

## Test Repo PRs (paramjeetn/pr-scrutiny-test-repo)

| PR | Branch | What It Tests |
|---|---|---|
| #1 | `feat/add-payment-endpoint` | SecurityAgent (original test PR — secrets + injection) |
| #3 | `feat/payment-service` | SecurityAgent HOLD — 10 findings (Stripe key, SQL injection, AWS key, etc.) |
| #4 | `feat/order-service` | QualityAgent WARN — N+1 query, blocking readFileSync, unreachable code |
| #5 | `feat/db-migration` | BlastRadiusAgent WARN — migration file + config change |
| #6 | `feat/notifications-service` | LLMAgent — clean code with tests, produces AI summary |

All PRs have had review comments posted by the integration tests with the updated UX formatter.
