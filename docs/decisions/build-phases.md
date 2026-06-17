# Build Phases

Each phase is a singular logical unit — build it, test it, then move on.
Phases 1–6 are pure logic with no external services (except LLM API key for Phase 5).
Phases 7–10 are integration with GitHub and Cloud Run.

---

## Phase 1 — Foundation

**What:** Types + fixture system. No logic, no API calls.

**Build:**
- Finalize all TypeScript types: `ReviewJob`, `FileDiff`, `FileContent`, `Finding`, `AgentResult`, `AgentTrace`, `JobTrace`, `Command`, `Severity`, `InstallationConfig`
- Create realistic test fixture folders:
  ```
  test-fixtures/pr-001-hardcoded-secret/
    pr.json           <- title, description, commit_messages, head_sha, repo
    diff.patch        <- unified diff of multiple changed files
    files/            <- full content of changed files
      src/config.js
      src/routes/users.js
      src/utils/db.js
    related/          <- 1-hop imports (unchanged files for cross-file analysis)
      src/middleware/auth.js
    package.json      <- dependency manifest
    existing_comments.json
    repo-tree.json    <- full list of repo file paths (for blast radius)
  ```
- Fixture loader: reads the folder -> produces a valid `ReviewJob`

**Test:**
- Fixture loader produces correctly shaped `ReviewJob`
- All required fields present and typed correctly
- TypeScript compiles with zero errors

**Done when:** `npm run typecheck` passes, fixture loads without errors.

---

## Phase 2 — Security Agent

**What:** First agent. All 4 passes. Pattern-based heuristics (regex + string matching). No AST.

**Build:**
- `src/agents/security/index.ts` — orchestrates 4 passes in parallel
- `src/agents/security/secrets.ts` — Pass 1: Secrets scanner
  - Regex patterns: AWS/GCP/GitHub/Stripe/Twilio keys, PEM headers, JWTs, connection strings
  - Shannon entropy analysis (> 4.5 bits/char, length > 20)
  - Base64 decode before scanning
  - Skip test fixtures, mock dirs, `.example` files
  - Entropy hits -> WARN. Pattern hits -> HOLD.
- `src/agents/security/injection.ts` — Pass 2: Injection surface
  - Grep for dangerous sinks: `exec()`, `eval()`, raw SQL concat, `innerHTML`, `dangerouslySetInnerHTML`
  - Check if argument is a literal string or a variable (heuristic)
  - Cross-file: grep `related_files` for the variable's origin (request params)
  - Severity: HOLD if sink + non-literal arg, WARN if ambiguous
- `src/agents/security/dependencies.ts` — Pass 3: Dependency audit
  - Parse `dependency_manifest` for added/bumped packages
  - Query OSV API for CVEs at CVSS >= 7.0
  - Flag yanked packages, packages < 30 days old with no prior version
  - Mock OSV in tests, real call in integration
- `src/agents/security/auth.ts` — Pass 4: Auth gap analysis
  - Find new route handlers in diff (regex: `app.get`, `router.post`, `@Get()`, etc.)
  - Grep for auth middleware import/usage in same file or related_files
  - Flag routes without auth wrapping
  - Flag `Access-Control-Allow-Origin: *` with `credentials: true`
  - Flag `algorithms: 'none'` in JWT config

**Fixture additions:** `pr-001` should contain a hardcoded API key, a raw SQL concat, a new route without auth.

**Test:**
- Each pass finds its planted finding
- Severities are correct (HOLD vs WARN)
- Clean code produces zero findings
- Returns valid `AgentResult` with `AgentTrace`

**Done when:** All 4 passes find what they should, miss what they should.

---

## Phase 3 — Quality Agent

**What:** Second agent. All 4 passes. Pattern-based heuristics.

**Build:**
- `src/agents/quality/index.ts` — orchestrates 4 passes in parallel
- `src/agents/quality/logic.ts` — Pass 1: Logic review
  - Off-by-one patterns in loop bounds and slice indices
  - Unreachable code after `return`/`throw`
  - Always-true/false conditions
  - Null deref on nullable types
- `src/agents/quality/complexity.ts` — Pass 2: Complexity scoring
  - Count branching keywords per function block (if/else/switch/for/while/catch/&&/||)
  - Thresholds: <=10 pass, 11-20 SUGGEST refactor, >20 WARN with decomposition note
- `src/agents/quality/test-coverage.ts` — Pass 3: Test coverage gaps
  - Find new functions added in diff
  - Check for corresponding test file (`*.test.ts`, `*.spec.ts`, `__tests__/`)
  - Only flag new code, not existing untested code
- `src/agents/quality/performance.ts` — Pass 4: Performance flags
  - DB calls inside loops (N+1 pattern)
  - `while(true)` without clear break/return
  - Blocking I/O in async context (`readFileSync` in async fn, `time.sleep` in asyncio)
  - `.collect()` / full array materialization on streams

**Fixture additions:** `pr-001` should have a high-complexity function, a loop with a DB call, a function with no tests.

**Test:**
- Each pass finds its planted issue
- Severities correct (WARN vs SUGGEST)
- Clean code produces zero findings
- Perf-only mode (`review:perf`) skips non-perf passes

**Done when:** All 4 passes work, clean code passes clean.

---

## Phase 4 — Blast Radius Agent

**What:** Static import graph traversal. No LLM, no GitHub API.

**Build:**
- `src/agents/blast-radius/index.ts`
- Import parser: extract `import`/`require` statements (regex, not AST)
  - JS/TS: `import ... from '...'`, `require('...')`
  - Python: `import ...`, `from ... import ...`
  - Go: `import "..."`
- Graph builder: file -> list of imports (resolved to repo paths)
- Traversal: from changed files, walk outward up to 2 hops, collect affected files
  - Stop at entry points or hop limit
- Classify:
  - Test files in affected set? Which are missing?
  - Config/env var changes in diff?
  - Migration files in diff?
  - Route handlers affected?

**Fixture:** `repo-tree.json` — full list of repo file paths + a subset of file contents for import parsing.

**Test:**
- Changing `src/utils/db.js` -> traversal finds all importers
- Test files correctly identified in affected set
- Returns correct `blast_radius` metadata structure
- Large repo (500+ files in tree) stays under 10s

**Done when:** Traversal correctly maps affected files from fixture data.

---

## Phase 5 — LLM Agent

**What:** First phase with actual LLM calls. Uses Vercel AI SDK.

**Build:**
- `src/agents/llm/index.ts` — orchestrates tasks, provider routing
- `src/agents/llm/summary.ts` — Task A: Auto-summary
  - System prompt: structured output for what/why/changed/NOT changed
  - Uses `generateObject()` with Zod schema
  - Input: diff + PR metadata (title, description, commits)
  - Output: `{ what: string, why: string, changed: string[], not_changed: string[] }`
- `src/agents/llm/questions.ts` — Task B: Intent questions
  - System prompt: 2-5 unanswered questions as structured JSON
  - Input: diff + PR description + existing comments (for dedup)
  - Output: `{ questions: [{ question: string, justification: string }] }`
- `src/agents/llm/ask.ts` — Conversational: answer a direct question about the PR
  - Uses `generateText()` — free-form answer, not structured
- Provider routing:
  ```typescript
  function getModel(provider: string, apiKey: string) {
    switch (provider) {
      case "anthropic": return anthropic("claude-sonnet-4-20250514", { apiKey })
      case "openai": return openai("gpt-4o", { apiKey })
      case "google": return google("gemini-2.5-flash", { apiKey })
    }
  }
  ```
- Token budget enforcement: if diff exceeds ~12k tokens, truncate per strategy in architecture doc

**Test:**
- Run against fixture with a real API key (env var)
- Assert output matches Zod schema — shape, not content
- Assert both tasks complete and return parseable results
- Test provider routing: mock each provider, assert correct one called
- Test token budget: oversized diff gets truncated, no error

**Done when:** Both tasks return valid structured output from a real LLM call.

---

## Phase 6 — Orchestrator + Formatter

**What:** Wire all agents together. No GitHub yet. CLI entrypoint.

**Build:**
- `src/orchestrator/router.ts` — command -> agent set mapping
  ```
  review          -> [Security, Quality, LLM, BlastRadius]
  review:security -> [Security]
  review:perf     -> [Quality(perf)]
  summarize       -> [LLM(summary)]
  ask             -> [LLM(conversational)]
  blast-radius    -> [BlastRadius]
  re-review       -> all + delta mode
  ```
- `src/orchestrator/dispatcher.ts` — run agents in parallel with per-agent timeouts
  - `Promise.allSettled` + `Promise.race` per agent for timeout
  - Collect `AgentResult[]` — include partial results on timeout
- `src/orchestrator/aggregator.ts`
  - Merge findings from all agents
  - Deduplicate: key on `(file, line)`, highest severity wins
  - Sort: HOLD -> WARN -> SUGGEST -> PASS -> QUESTION
- `src/orchestrator/formatter.ts`
  - Split: inline findings (have file + line) vs top-level
  - Build inline payloads: `[{ path, line, body }]`
  - Build top-level markdown: severity sections, questions, summary, blast radius, agent trace
- `src/cli.ts` — CLI entrypoint
  ```
  npx tsx src/cli.ts review ./test-fixtures/pr-001-hardcoded-secret
  npx tsx src/cli.ts summarize ./test-fixtures/pr-001-hardcoded-secret
  npx tsx src/cli.ts blast-radius ./test-fixtures/pr-001-hardcoded-secret
  ```
  Loads fixture -> builds ReviewJob -> runs orchestrator -> prints formatted output to stdout

**Test:**
- Mock all agents with known `AgentResult` outputs
- Assert correct agents called for each command (and only those)
- Assert dedup: two findings on same line -> highest severity kept
- Assert formatter: inline vs top-level split correct, markdown structure valid
- Assert `/re-review` delta: given prev + new findings, delta computed correctly
- Assert timeout: mock a slow agent, assert partial results returned with timeout note
- Assert CLI: produces readable output for human review

**Done when:** `npx tsx src/cli.ts review ./test-fixtures/pr-001` prints a correctly structured review to stdout.

---

## Phase 7 — Cloud Run Server + Webhook Handler

**What:** HTTP server on Cloud Run. Receives webhooks, dispatches jobs.

**Build:**
- `src/server.ts` — Hono HTTP server
- `src/webhook/handler.ts`
  - HMAC-SHA256 signature validation
  - Event type routing (pull_request, issue_comment, etc.)
  - Slash command parser: extract command + args from comment body
  - Collaborator check
- `src/webhook/idempotency.ts`
  - Check `X-GitHub-Delivery` header against Firestore
  - Check job dedup: `(repo, pr_number, head_sha)` not already running
- Async processing: return 200, then continue with orchestrator
- Dockerfile + Cloud Run config

**Test:**
- Invalid HMAC -> 401
- Unknown event type -> 200 no-op
- Slash command parsed correctly
- Duplicate webhook -> skipped
- Duplicate job (same PR + SHA) -> skipped with message

**Done when:** Server handles all webhook scenarios correctly in local dev.

---

## Phase 8 — GitHub Integration

**What:** Context Assembler + Comment Poster. First real GitHub API calls.

**Build:**
- `src/github/auth.ts` — JWT signing -> Installation Access Token exchange
- `src/github/context.ts` — Context Assembler
  - Fetch diff: `GET /pulls/{id}/files`
  - Fetch PR metadata: `GET /pulls/{id}`
  - Fetch changed file contents: `GET /contents/{path}?ref={sha}`
  - Fetch related_files: parse imports from changed files -> fetch 1-hop (max 10)
  - Fetch dependency manifest
  - Fetch `.pr-scrutiny.yml` config, apply defaults
  - Enforce diff size limits (25 files, 500 lines)
  - Assemble -> `ReviewJob`
- `src/github/poster.ts` — Comment Poster
  - Post provisional comment -> store comment_id
  - Post inline review (batched): `POST /pulls/{id}/reviews`
  - Post top-level summary: `POST /issues/{id}/comments`
  - Delete provisional comment
- `src/github/errors.ts` — API key failure classification -> email alert (no GitHub comment)

**Test:**
- Mock Octokit: context assembler produces valid ReviewJob
- Mock Octokit: poster makes correct API calls with correct payloads
- related_files assembly: imports parsed, files fetched
- Diff over limit: files prioritized and skipped correctly
- Full pipeline: slash command -> review comment on a real test PR

**Done when:** `/review` on a real PR produces a correctly structured review comment.

---

## Phase 9 — Storage + Installation Config + Setup Page

**What:** Firestore layer (API keys, job state, idempotency) + the settings UI users see after installing the GitHub App.

**Build:**
- `src/storage/installations.ts`
  - `getInstallation(id)` -> `InstallationConfig`
  - `setInstallation(id, config)` -> encrypt API key (KMS), store in Firestore
- `src/storage/jobs.ts`
  - `saveFindings(jobKey, findings)` -> store with 4h TTL
  - `getFindings(jobKey)` -> `AgentResult[] | null`
  - `saveTrace(jobId, trace)` -> store with 7d TTL
- `src/storage/idempotency.ts`
  - `checkAndClaim(deliveryId)` -> boolean (true if new, false if duplicate)
  - 24h TTL on entries
  - Replace in-memory Sets in `src/webhook/idempotency.ts` with Firestore-backed version
- `src/setup/page.ts` — serves `GET /setup?installation_id=X`
  - Returns a small HTML page (no React — just a single HTML file served by Hono)
  - If installation already exists, pre-fills provider/model/email with current config (key masked as `sk-ant-••••••1234`)
  - Form fields:
    1. **Provider** — dropdown: `Anthropic | OpenAI | Google`
    2. **Model** — dropdown, updates based on provider selection:
       - Anthropic: `claude-sonnet-4-6 | claude-opus-4-6 | claude-haiku-4-5`
       - OpenAI: `gpt-4o | gpt-4o-mini | gpt-4.1 | gpt-4.1-mini`
       - Google: `gemini-2.5-pro | gemini-2.5-flash | gemini-2.0-flash`
    3. **API Key** — text input, masked, placeholder shows expected format
    4. **Email** — required, for error alerts (invalid key, quota exceeded, provider outage)
    5. **Save & Activate** button
- `src/setup/handler.ts` — handles `POST /setup`
  - Basic format validation: `sk-ant-` prefix for Anthropic, `sk-` for OpenAI, `AIza` for Google
  - Test call: make a cheap LLM call (`"say hi"`, max 5 tokens) to verify the key actually works before saving
  - On success: encrypt with KMS, store `{ api_key, provider, model, email }` in Firestore
  - Show success page: "You're all set. PR Scrutiny is now active on your repos."
  - On key failure: show error inline, do not store
  - Page doubles as settings — revisit any time to update provider, model, or key

**`InstallationConfig` type:**
```typescript
interface InstallationConfig {
  api_key: string        // KMS-encrypted at rest
  provider: 'anthropic' | 'openai' | 'google'
  model: string          // e.g. "claude-sonnet-4-6"
  email: string          // required
  active: boolean
  created_at: string
  updated_at: string
}
```

**Test:**
- API key encrypted before write, decrypted on read
- TTL set correctly on job findings and idempotency entries
- Setup page renders correctly for new install (empty) and returning visit (pre-filled, masked key)
- Key validation: invalid format rejected before test call
- Test call failure (bad key) -> error shown, nothing stored
- Test call success -> config stored, success page shown
- Model dropdown updates correctly per provider (JS in the HTML page)
- Webhook handler reads installation token from Firestore (not env var)

**Done when:** Full install flow works — GitHub App install -> redirect to `/setup` -> fill in key -> save -> reviews work on real PRs.

---

## Phase 10 — GitHub App Registration + Deploy + E2E

**What:** Register the GitHub App, deploy to Cloud Run, wire everything together, run E2E tests against production.

### Step A — Register the GitHub App (manual, one-time)

Do this before writing any deploy code. You need the App ID and private key before the server can exchange tokens.

1. Go to `github.com/settings/apps/new` (personal) or `github.com/organizations/{org}/settings/apps/new` (org)
2. **App name:** `PR Scrutiny` (must be globally unique on GitHub)
3. **Homepage URL:** your Cloud Run URL (placeholder OK at first, update after deploy)
4. **Webhook URL:** `https://<cloud-run-url>/webhook` — update after first deploy
5. **Webhook secret:** generate a random 32-byte hex string, save it — this goes into Secret Manager as `GITHUB_WEBHOOK_SECRET`
6. **Permissions (Repository):**
   - `Contents`: Read (to fetch file contents + repo tree)
   - `Pull requests`: Read & Write (to read diffs + post review comments)
   - `Issues`: Read & Write (to post top-level PR comments)
   - `Metadata`: Read (required by GitHub for all apps)
7. **Subscribe to events:**
   - `Pull request` (opened, reopened, synchronize)
   - `Issue comment` (created — for slash commands)
8. **Where can this GitHub App be installed?** — `Any account` (for public launch) or `Only on this account` (for testing)
9. Click **Create GitHub App**
10. Note the **App ID** (shown at top of app settings page)
11. Scroll to **Private keys** → **Generate a private key** → downloads a `.pem` file
12. Store in GCP Secret Manager:
    - `GITHUB_APP_ID` = the numeric app ID
    - `GITHUB_APP_PRIVATE_KEY` = contents of the `.pem` file
    - `GITHUB_WEBHOOK_SECRET` = the random hex string from step 5

**After deploy (step B):** come back and update the Webhook URL to the real Cloud Run URL, then click **Save changes**.

**Setup redirect URL:** In app settings → **Callback URL** → set to `https://<cloud-run-url>/setup`. GitHub redirects here after a user installs the app. The `installation_id` query param is passed automatically.

---

### Step B — Dockerfile + Cloud Run Config

**Build:**
- `Dockerfile`
  ```dockerfile
  FROM node:22-alpine
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci --production
  COPY . .
  RUN npm run build
  EXPOSE 8080
  CMD ["node", "dist/server.js"]
  ```
- `tsconfig.build.json` — separate tsconfig that outputs to `dist/`, excludes test files
- `cloudbuild.yaml` — Cloud Build trigger:
  ```yaml
  steps:
    - name: 'gcr.io/cloud-builders/docker'
      args: ['build', '-t', 'gcr.io/$PROJECT_ID/pr-scrutiny:$COMMIT_SHA', '.']
    - name: 'gcr.io/cloud-builders/docker'
      args: ['push', 'gcr.io/$PROJECT_ID/pr-scrutiny:$COMMIT_SHA']
    - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
      args:
        - run
        - deploy
        - pr-scrutiny
        - --image=gcr.io/$PROJECT_ID/pr-scrutiny:$COMMIT_SHA
        - --region=us-central1
        - --platform=managed
        - --allow-unauthenticated
        - --concurrency=1
        - --memory=512Mi
        - --timeout=120s
  ```
- Cloud Run env vars (all from Secret Manager):
  - `GITHUB_APP_ID`
  - `GITHUB_APP_PRIVATE_KEY`
  - `GITHUB_WEBHOOK_SECRET`
  - `GCP_PROJECT_ID`
  - `KMS_KEY_NAME` (for installation API key encryption)

**GCP setup (one-time CLI commands):**
```bash
# Enable APIs
gcloud services enable run.googleapis.com firestore.googleapis.com \
  cloudkms.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com

# Create Firestore database (native mode)
gcloud firestore databases create --region=us-central1

# Create KMS keyring + key for API key encryption
gcloud kms keyrings create pr-scrutiny --location=global
gcloud kms keys create installation-keys \
  --keyring=pr-scrutiny --location=global \
  --purpose=encryption

# Store secrets
echo -n "$GITHUB_APP_PRIVATE_KEY" | \
  gcloud secrets create GITHUB_APP_PRIVATE_KEY --data-file=-
echo -n "$GITHUB_WEBHOOK_SECRET" | \
  gcloud secrets create GITHUB_WEBHOOK_SECRET --data-file=-
echo -n "$GITHUB_APP_ID" | \
  gcloud secrets create GITHUB_APP_ID --data-file=-

# Grant Cloud Run SA access to secrets + KMS + Firestore
PROJECT_ID=$(gcloud config get-value project)
SA="$PROJECT_ID-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA" --role="roles/datastore.user"
gcloud kms keys add-iam-policy-binding installation-keys \
  --keyring=pr-scrutiny --location=global \
  --member="serviceAccount:$SA" --role="roles/cloudkms.cryptoKeyEncrypterDecrypter"
```

---

### Step C — E2E Tests (production)

**File:** `tests/e2e/cloud-run.e2e.test.ts`

Skipped unless `E2E=true` and `CLOUD_RUN_URL` env vars set. These tests hit the real deployed service.

**Tests:**
- `GET /health` returns `{status:'ok'}` within 2s (cold start included)
- `POST /webhook` with invalid HMAC → 401 (server running, HMAC wired correctly)
- `POST /webhook` with valid ping event → 200 pong (webhook secret correct)
- Webhook triggers real review on test PR:
  - POST a `/review:security` comment to PR #3 via GitHub API
  - Wait up to 60s for a new review comment to appear on the PR
  - Assert the comment body contains `## PR Scrutiny`
  - Assert it contains `HOLD` or `blocking` (secrets + injection fixture)
- Webhook triggers real summarize on test PR:
  - POST a `/summarize` comment to PR #6 via GitHub API
  - Wait up to 90s for new review comment (LLM involved)
  - Assert comment contains `### 🤖 AI Summary`
  - Assert comment contains `## PR Scrutiny`
- Setup page:
  - `GET /setup?installation_id=test` → 200 with HTML form
  - `POST /setup` with bad API key → response contains error message
  - `POST /setup` with valid API key → response contains success message, config stored in Firestore

**Done when:** All E2E tests pass against the live Cloud Run URL. `/review` on a real PR produces a complete review comment within 90 seconds of the slash command being typed.

---

## Summary

| Phase | What | External deps |
|---|---|---|
| 1 | Types + fixtures | None |
| 2 | Security Agent | None (mock OSV) |
| 3 | Quality Agent | None |
| 4 | Blast Radius Agent | None |
| 5 | LLM Agent | LLM API key |
| 6 | Orchestrator + Formatter + CLI | None (or LLM key for full run) |
| 7 | Cloud Run Server + Webhooks | Docker |
| 8 | GitHub Integration | GitHub API (mocked, then real) |
| 9 | Firestore + Installation Config | GCP Firestore + KMS |
| 10 | E2E + Deploy | GitHub App + Cloud Run + real PR |

Phases 1-6: zero infrastructure. Build and test entirely locally with fixtures.
Phase 5 onwards: needs an LLM API key for the LLM agent only.
Phase 8: first time real GitHub API is involved.
Phase 10: first production deploy.
