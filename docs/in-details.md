# PR Scrutiny — Full Project Details

## What We Built

PR Scrutiny is a production GitHub App that acts as an AI-powered first-pass code reviewer. When a pull request is opened or a user types a slash command like `/review` in a PR comment, the app:

1. Receives the GitHub webhook
2. Posts a provisional "working..." comment immediately
3. Fetches the full diff + file contents from the GitHub API
4. Runs 4 specialist agents in parallel (Security, Quality, Blast Radius, LLM)
5. Posts structured inline review comments + a summary comment
6. Deletes the provisional comment

The app is live at `https://pr-scrutiny-ty7nkvdzfq-uc.a.run.app` and installed on GitHub as **PR Scrutiny** (App ID: 4092362).

---

## Architecture

### Runtime
- **Google Cloud Run** — scales to zero, no idle cost, no CPU time limits
- **Concurrency: 1** — each Cloud Run instance handles one job at a time (job isolation)
- **TypeScript / Node.js 22** — compiled to ESM, run with `node dist/server.js`
- **Hono** — lightweight HTTP framework for webhook and setup routes

### Request Flow

```
GitHub Webhook POST /webhook
  → HMAC-SHA256 signature verification
  → Webhook dedup (X-GitHub-Delivery header, 24h TTL)
  → Parse event (pull_request or issue_comment slash command)
  → Job dedup check (in-memory + Firestore, 4h TTL)
  → Return 200 immediately
  → setImmediate: resolve installation token (JWT → GitHub API)
  → Post provisional comment ("reviewing..." / "summarizing..." etc.)
  → Fetch Firestore config (API key, provider, model)
  → assembleContext: fetch PR diff + file contents from GitHub API
  → runOrchestrator: 4 agents in parallel with timeouts
  → postReview: inline comments + summary comment
  → Delete provisional comment
```

### Data Contract

Everything flows through `ReviewJob` — a single typed object assembled from the GitHub API. Agents only read from it, never call GitHub directly. This means agents are pure functions testable with local fixtures.

### Agents

| Agent | Type | Timeout | What it checks |
|---|---|---|---|
| SecurityAgent | Pattern-based (regex + entropy) | 30s | Hardcoded secrets, injection sinks, missing auth, dependency CVEs via OSV API |
| QualityAgent | Pattern-based heuristics | 30s | N+1 queries, complexity, missing test coverage, performance anti-patterns |
| BlastRadiusAgent | Static import graph traversal | 30s | Affected files, routes, config changes, migration files, missing tests |
| LLMAgent | Vercel AI SDK (customer's key) | 60s | AI summary, questions for author, `/ask` conversational answers |

Static agents make zero LLM calls. Only LLMAgent uses the customer's API key.

### Severity Levels

`HOLD` (blocks merge) → `WARN` → `SUGGEST` → `PASS` → `QUESTION`

### Storage (Firestore)

| Collection | Contents | TTL |
|---|---|---|
| `installations/{id}` | API key (KMS-encrypted), provider, model, email | Permanent |
| `jobs/{repo}:{pr}:{sha}` | Status, findings, trace | 4h |
| `idempotency/{delivery_id}` | Webhook dedup | 24h |
| `cve_cache/{pkg}:{version}` | OSV CVE results | 6h |

### Key Encryption

API keys encrypted at rest using Google Cloud KMS (AES-256). Keyring: `pr-scrutiny`, key: `installation-keys`. Encrypted on write via `setInstallation()`, decrypted on read via `getInstallation()`.

---

## Build Phases — What Was Done

### Phase 1 — Types + Fixtures + Scaffold

- Defined all TypeScript types: `ReviewJob`, `FileDiff`, `FileContent`, `Finding`, `AgentResult`, `AgentTrace`, `JobTrace`, `Command`, `Severity`, `LLMProvider`, `InstallationConfig`, `RepoConfig`
- Built fixture loader (`src/fixtures/loader.ts`) — reads a fixture folder → produces a valid `ReviewJob`
- Created fixture `tests/fixtures-data/pr-001-hardcoded-secret/` with realistic planted issues: hardcoded Stripe key, SQL injection, eval(), N+1 loop, no-auth routes
- Fixture contains: `pr.json`, `diff.patch`, `files/` (full file contents), `related/` (1-hop imports), `package.json`, `existing_comments.json`, `repo-tree.json`

### Phase 2 — Security Agent

4 passes, each in its own file:

- **`secrets.ts`** — regex patterns for API keys, tokens, passwords; Shannon entropy scoring for high-entropy strings; AWS/GCP/Stripe/GitHub key detection
- **`injection.ts`** — SQL injection (string concatenation into queries), command injection (`exec`, `spawn` with user input), XSS sinks (`innerHTML`, `document.write`)
- **`auth.ts`** — unprotected route patterns (route handlers with no middleware), missing authentication checks on sensitive endpoints
- **`dependencies.ts`** — reads `package.json`, queries OSV.dev API for known CVEs per dependency version

### Phase 3 — Quality Agent

4 passes:

- **`logic.ts`** — unsafe equality (`==` instead of `===`), `console.log` in production paths, error swallowing (`catch {}` with no handling)
- **`complexity.ts`** — deeply nested conditionals (>4 levels), functions >50 lines, files >300 lines changed
- **`test-coverage.ts`** — changed source files with no corresponding test file in diff or repo tree
- **`performance.ts`** — N+1 query patterns (DB calls inside loops), synchronous blocking I/O (`fs.readFileSync`, `execSync`), missing database indexes on filtered fields

### Phase 4 — Blast Radius Agent

- **`parser.ts`** — extracts import/require statements from JS/TS files
- **`graph.ts`** — builds 1-hop import graph from changed files into `related_files`
- **`classify.ts`** — classifies affected files (routes, config, migrations, test files)
- **`index.ts`** — orchestrates: finds affected files, identifies missing test coverage, detects config/migration changes, reports hop count

### Phase 5 — LLM Agent (Vercel AI SDK)

Three call types, each in its own file:

- **`summary.ts`** — generates plain-English summary of what the PR does and why, as a `PASS` finding
- **`questions.ts`** — generates clarifying questions for the author as `QUESTION` findings
- **`ask.ts`** — answers a specific user question about the diff conversationally

Uses `generateText()` from Vercel AI SDK with `maxOutputTokens: 16` minimum (OpenAI enforces this). Supports Anthropic, OpenAI, Google providers. Token budget: ~12k tokens per call.

### Phase 6 — Orchestrator + Formatter + CLI

- **`router.ts`** — maps `Command` to agent list (`review` → all 4, `review:security` → SecurityAgent only, etc.)
- **`dispatcher.ts`** — runs agents in parallel with `Promise.allSettled` + per-agent timeouts (30s/60s); timed-out agents return empty findings with `timed_out: true`
- **`aggregator.ts`** — merges findings from all agents; deduplicates by `(file, line)` keeping highest severity; sorts by severity order; builds `JobTrace` with per-agent timing and token usage
- **`formatter.ts`** — splits findings into inline comments (have file+line) and summary (no line); renders GitHub Markdown with severity labels, remediation hints, AI summary section, questions section, collapsed `<details>` agent trace block
- **`cli.ts`** — CLI entrypoint: `node dist/cli.js <fixture-dir> [command]` runs the full pipeline locally without any server or GitHub connection

### Phase 7 — Hono Server + Webhook Handler

- **`server.ts`** — Hono app with routes: `GET /` (landing page), `GET /health`, `GET /setup`, `POST /setup`, `POST /webhook`
- **`webhook/handler.ts`** — full webhook processing: HMAC validation, dedup, event parsing, command detection, job lifecycle (claim → process → release), async processing via `setImmediate`
- **`webhook/hmac.ts`** — `verifySignature()` using Node.js `crypto.timingSafeEqual` to prevent timing attacks
- **`webhook/parser.ts`** — `parseSlashCommand()` handles `/review`, `/ask <question>`, etc.; `parseWebhookContext()` extracts PR number, headSha, repo, installationId from raw webhook body
- **`webhook/idempotency.ts`** — in-memory delivery dedup (24h TTL) and job dedup (per repo+PR+SHA)

### Phase 8 — GitHub Integration

- **`github/auth.ts`** — `getInstallationToken()`: signs RS256 JWT with GitHub App private key, exchanges for installation access token (1h expiry)
- **`github/context.ts`** — `assembleContext()`: fetches PR metadata, diff (via compare API), file contents, related files (1-hop imports), repo tree, existing comments; enforces limits (25 files, 500 diff lines, 1000 lines/file)
- **`github/poster.ts`** — `CommentPoster` class: `postProvisional(prNumber, command)` posts command-specific working message; `postInlineReview()` batches inline comments into single `POST /pulls/{id}/reviews`; `postReview()` orchestrates full flow; `deleteComment()` removes provisional

### Phase 9 — Firestore Storage + KMS + Setup Page

- **`storage/firestore.ts`** — Firestore singleton with test injection hooks (`_setDb`, `_resetDb`)
- **`storage/kms.ts`** — `encryptApiKey()` / `decryptApiKey()` via `@google-cloud/kms`
- **`storage/installations.ts`** — `getInstallation()` (decrypts key), `setInstallation()` (encrypts key, preserves `created_at`), `deleteInstallation()`
- **`storage/jobs.ts`** — `saveFindings/getFindings` (4h TTL), `saveTrace/getTrace` (7d TTL)
- **`storage/idempotency.ts`** — `checkAndClaimDelivery()` and `checkAndClaimJob()` via Firestore transactions (atomic, handles concurrent webhook deliveries)
- **`setup/page.ts`** — `renderSetupPage()`: HTML form for API key entry; provider/model dropdowns with JS update; masked key display (`sk-ant-••••••••1234`); success state replaces form with clean ✅ confirmation page; submit button shows spinner + disables during verification
- **`setup/handler.ts`** — `handleSetupGet` / `handleSetupPost`: validates key format (`sk-ant-`, `sk-`, `AIza`), tests key live with a cheap `generateText` call, saves to Firestore via KMS; non-auth errors (503 etc.) don't block save

### Phase 10 — Dockerfile + Cloud Run Deploy

- **`Dockerfile`** — `node:22-alpine`, installs all deps → builds TypeScript → prunes dev deps → `node dist/server.js`
- **`.dockerignore`** — excludes `node_modules`, `dist`, `.env`, `tests`, `docs`, `worker`
- **`cloudbuild.yaml`** — builds image → pushes to Artifact Registry → deploys to Cloud Run with secrets mounted
- GCP project: `pr-scrutiny` (project number: 111649641571), region: `us-central1`
- Secrets in Secret Manager: `github-app-private-key`, `github-webhook-secret`, `openai-api-key`
- Cloud Run flags: `--concurrency=1`, `--memory=512Mi`, `--timeout=300`

### Post-Deploy Fixes + UX

- **Double-post dedup fix** — slash commands don't carry `headSha`; job key fell back to `comment-${deliveryId}` which didn't match the PR sync job key. Fixed: `${command}-${prNumber}` as synthetic SHA
- **Setup key test min tokens** — OpenAI minimum `maxOutputTokens` is 16, not 5. Fixed in setup handler
- **Setup page success UX** — on success, replace form entirely with clean ✅ confirmation page + "Update settings" link. Submit button shows spinner + disables while key is being verified
- **Provisional comment ordering** — `postProvisional()` was called after `getInstallation()` (Firestore call). Moved before so it fires as fast as possible
- **Command-specific provisional messages**:
  - `/review`, `/re-review`, `/review:*` → `🔍 PR Scrutiny is reviewing this PR...`
  - `/summarize` → `📝 PR Scrutiny is summarizing this PR...`
  - `/ask` → `💬 PR Scrutiny is thinking...`
  - `/blast-radius` → `💥 PR Scrutiny is mapping blast radius...`
- **Landing page** — dark GitHub-style HTML page at `/` with commands reference, how it works, severity levels, install button

---

## Test Suite — 222 Tests Across 14 Files

### Unit Tests

#### `tests/fixtures/loader.test.ts` — 16 tests
Validates fixture loader: shape validation, UUID generation, PR fields, diff structure, file contents, options passthrough.

#### `tests/security/security-agent.test.ts` — 28 tests
- Secrets: detects hardcoded API keys, Stripe keys, high-entropy strings; ignores placeholders and test values
- Injection: SQL string concatenation, parameterized queries (no false positive), command injection via `exec`
- Auth: unprotected route detection, routes with middleware (no false positive)
- Dependencies: CVE detection via OSV (mocked), clean packages pass

#### `tests/quality/quality-agent.test.ts` — 20 tests
- Logic: unsafe equality, `console.log` in prod, swallowed errors
- Complexity: deeply nested code, long functions, large file changes
- Test coverage: changed source file with no test, changed test file (no finding), changed file with matching test
- Performance: N+1 loop pattern, synchronous `readFileSync`, clean async code (no false positive)

#### `tests/blast-radius/blast-radius.test.ts` — 22 tests
- Import parser: ES modules, CommonJS require, re-exports, ignores non-local imports
- Graph builder: finds 1-hop affected files, handles circular imports
- Classifier: identifies routes, config files, migrations, test files
- Full agent: missing tests flagged, config change detected, migration detected

#### `tests/llm/llm-agent.test.ts` — 17 tests
- Summary prompt building, question extraction, ask command handling
- Token counting, model selection per provider
- All LLM calls mocked (Vercel AI SDK mock)

#### `tests/webhook/webhook.test.ts` — 29 tests
- HMAC: valid signature passes, tampered body rejected, timing-safe comparison
- Parser: slash commands (`/review`, `/ask question`, `/blast-radius`), non-slash ignored, whitespace handling
- Webhook context: pull_request events, issue_comment events, non-PR issue comments ignored
- Handler: ping response, duplicate delivery skipped, unhandled events skipped, job dedup, missing token skipped, 200 returned immediately with queued flag

#### `tests/github/context.test.ts` — 10 tests
- Context assembler: PR metadata extraction, diff parsing, file content fetching, related file resolution, repo tree loading (all mocked via Octokit)

#### `tests/github/poster.test.ts` — 11 tests
- `postProvisional`: posts command-specific messages (`review` → reviewing, `summarize` → summarizing, `ask` → thinking, `blast-radius` → blast radius)
- `deleteComment`: calls GitHub delete API; failure is silent (non-fatal)
- `postSummary`: posts markdown, returns comment ID
- `postInlineReview`: batches comments into single createReview call; skips when no inline comments
- `postReview`: posts inline + summary, deletes provisional; inline failure doesn't prevent summary

#### `tests/orchestrator/orchestrator.test.ts` — 28 tests
- Router: `review` → 4 agents, `review:security` → SecurityAgent only, `summarize` → LLMAgent only, etc.
- Aggregator: merges findings, deduplicates by file+line (highest severity wins), sorts by severity order, includes all agent traces, captures LLM token usage
- Formatter: inline findings → inline array, no-line findings → summary only, HOLD findings → blocking issue banner, clean status when no HOLD/WARN, questions rendered in dedicated section, agent trace as collapsed `<details>`, remediation in inline comment body
- Full orchestrator run on fixture: valid shape, HOLD findings detected, PR Scrutiny header, trace counts match

#### `tests/storage/storage.test.ts` — 17 tests
- Installations: encrypt/decrypt round-trip, `created_at` preserved on update, delete works, unknown ID returns null
- Jobs: findings saved and retrieved, trace saved and retrieved, expired records rejected on read
- Idempotency: delivery dedup (second claim returns false), job claim/release lifecycle, stale lock detection

#### `tests/setup/setup.test.ts` — 14 tests
- GET: 400 on missing installation_id, renders form, pre-fills existing provider/model/email, shows masked key, all model options present
- POST: 400 on missing id, invalid provider rejected, invalid model rejected, missing email rejected, wrong key prefix rejected, 401 key rejected (no save), valid key saves and shows success, blank key keeps existing (no re-test), 503 doesn't block save

### Integration Tests (hit real APIs)

#### `tests/llm/llm-agent.integration.test.ts` — 2 tests
Uses real OpenAI API (`gpt-4o-mini`) with fixture data:
- `summarize`: returns a PASS summary finding + QUESTION findings from real LLM call
- `ask`: answers a specific question about the diff from real LLM call

#### `tests/github/github.integration.test.ts` — 3 tests
Uses real GitHub API + real test repo (`paramjeetn/pr-scrutiny-test-repo`):
- Assembles `ReviewJob` from real PR #1 via GitHub API
- Runs SecurityAgent on real PR diff (finds real issues)
- Posts a real blast-radius review comment to PR #1 on GitHub

#### `tests/github/full-pipeline.integration.test.ts` — 5 tests
End-to-end pipeline on 4 deliberately broken PRs in the test repo:
- **PR #3** (`payment-service`) — `review:security` finds HOLD for hardcoded Stripe key + SQL injection
- **PR #4** (`order-service`) — `review:perf` finds N+1 query pattern + blocking `readFileSync`
- **PR #5** (`db-migration`) — `blast-radius` detects migration file + config changes
- **PR #6** (`notifications`) — `summarize` produces AI summary of clean code (no HOLD)
- **PR #3 combined** — `review:security` + `blast-radius` together, 10 findings, 9 inline comments

---

## Test Repo (`paramjeetn/pr-scrutiny-test-repo`)

Created specifically to test the app. Contains 8 PRs:

| PR | Branch | Purpose |
|---|---|---|
| #1 | `test/blast-radius-simple` | GitHub integration tests (real API calls) |
| #3 | `test/payment-service-vuln` | `src/cart.js` — hardcoded Stripe key, SQL injection, N+1 |
| #4 | `test/order-service-perf` | Performance issues — N+1 loop, `readFileSync` |
| #5 | `test/db-migration` | Blast radius — migration file + config changes |
| #6 | `test/notifications-clean` | Clean code — tests summarize on good PR |
| #7 | First live E2E test | Confirmed full bot response: inline HOLD comments, AI summary, questions |
| #8 | `/review` and `/summarize` live commands | Verified provisional comment + full review flow |

---

## Live Deployment

| Item | Value |
|---|---|
| URL | `https://pr-scrutiny-ty7nkvdzfq-uc.a.run.app` |
| GCP Project | `pr-scrutiny` (111649641571) |
| Region | `us-central1` |
| Current image | `v11` |
| GitHub App ID | `4092362` |
| GitHub App name | `pr-scrutiny` |
| Webhook secret | Stored in Secret Manager (`github-webhook-secret`) |
| Private key | Stored in Secret Manager (`github-app-private-key`) |
| Firestore mode | Native |
| KMS keyring | `pr-scrutiny` / key `installation-keys` |

### Deploy command
```bash
gcloud builds submit --config=cloudbuild.yaml --project=pr-scrutiny --substitutions=COMMIT_SHA=vN
```

### Routes
| Route | Purpose |
|---|---|
| `GET /` | Landing page (dark GitHub-style, commands reference, install button) |
| `GET /health` | Health check → `{"ok":true}` |
| `GET /setup?installation_id=N` | Setup form — enter API key after installing app |
| `POST /setup` | Form submit — validates key, saves to Firestore via KMS |
| `POST /webhook` | GitHub webhook receiver |

---

## Slash Commands Reference

| Command | Trigger | What runs |
|---|---|---|
| `/review` | Manual | All 4 agents |
| `/review:security` | Manual | SecurityAgent only |
| `/review:perf` | Manual | QualityAgent only |
| `/blast-radius` | Manual | BlastRadiusAgent only |
| `/summarize` | Manual | LLMAgent only |
| `/ask <question>` | Manual | LLMAgent (conversational) |
| `/re-review` | Manual | All 4 agents |
| *(PR opened/pushed/reopened)* | Automatic | All 4 agents |

---

## Key Technical Decisions

- **Cloud Run over CF Workers** — no CPU limits, full Node.js, no sandbox restrictions, native GCP
- **Agents never call GitHub** — only Context Assembler does; agents are pure functions over `ReviewJob`
- **BYOK (Bring Your Own Key)** — customer pastes their Anthropic/OpenAI/Google key at install; stored KMS-encrypted
- **Static agents make zero LLM calls** — only LLMAgent uses the LLM; keeps cost predictable
- **Inline comments batched** — single `POST /pulls/{id}/reviews` with all inline comments; atomic
- **Partial results on timeout** — if one agent hangs, others' findings still post
- **At-least-once webhook delivery** — GitHub may deliver duplicates; deduplicated via `X-GitHub-Delivery` header in Firestore
- **setImmediate for async processing** — webhook returns 200 before job starts; job runs in next event loop tick
- **Provisional comment before slow calls** — posted before `assembleContext` (GitHub API) and `runOrchestrator` (agents) so user sees feedback within ~1s of triggering

---

## File Map

```
pr-scrutiny/
  src/
    types/index.ts                    # All TypeScript types
    fixtures/loader.ts                # Fixture → ReviewJob
    agents/
      security/
        index.ts                      # SecurityAgent orchestrator
        secrets.ts                    # Regex + entropy scanning
        injection.ts                  # SQL/command/XSS injection
        auth.ts                       # Missing auth detection
        dependencies.ts               # OSV CVE lookup
      quality/
        index.ts                      # QualityAgent orchestrator
        logic.ts                      # Logic bugs + console.log
        complexity.ts                 # Nesting + function length
        test-coverage.ts              # Missing test files
        performance.ts                # N+1 + blocking I/O
      blast-radius/
        index.ts                      # BlastRadiusAgent orchestrator
        parser.ts                     # Import extractor
        graph.ts                      # 1-hop import graph
        classify.ts                   # Route/config/migration classifier
      llm/
        index.ts                      # LLMAgent orchestrator
        summary.ts                    # PR summary call
        questions.ts                  # Author questions call
        ask.ts                        # /ask conversational call
    orchestrator/
      index.ts                        # runOrchestrator()
      router.ts                       # Command → agent list
      dispatcher.ts                   # Parallel run + timeouts
      aggregator.ts                   # Merge + dedup + sort
      formatter.ts                    # → GitHub Markdown
    github/
      auth.ts                         # JWT → installation token
      context.ts                      # assembleContext()
      poster.ts                       # CommentPoster class
    webhook/
      handler.ts                      # handleWebhook()
      hmac.ts                         # HMAC-SHA256 verification
      parser.ts                       # Slash command + event parser
      idempotency.ts                  # In-memory dedup
    storage/
      firestore.ts                    # Singleton + test hooks
      kms.ts                          # Encrypt/decrypt API keys
      installations.ts                # CRUD for installation configs
      jobs.ts                         # Findings + trace storage
      idempotency.ts                  # Firestore-backed dedup
    setup/
      handler.ts                      # GET + POST /setup
      page.ts                         # Setup HTML page
    landing/
      page.ts                         # Landing HTML page
    server.ts                         # Hono app + startup
    cli.ts                            # Local CLI runner
  tests/
    fixtures-data/pr-001-hardcoded-secret/   # Realistic fixture
    fixtures/loader.test.ts
    security/security-agent.test.ts
    quality/quality-agent.test.ts
    blast-radius/blast-radius.test.ts
    llm/llm-agent.test.ts
    llm/llm-agent.integration.test.ts
    orchestrator/orchestrator.test.ts
    webhook/webhook.test.ts
    github/context.test.ts
    github/poster.test.ts
    github/github.integration.test.ts
    github/full-pipeline.integration.test.ts
    storage/storage.test.ts
    setup/setup.test.ts
  Dockerfile
  cloudbuild.yaml
  .dockerignore
  package.json
  tsconfig.json
  vitest.config.ts
  CLAUDE.md
```
