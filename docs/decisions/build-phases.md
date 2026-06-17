# Build Phases

Each phase is a singular logical unit — build it, test it, then move on.
Phases 1–7 are pure logic with no external services.
Phases 8–12 are integration with GitHub and Cloudflare.

---

## Phase 1 — Foundation

**What:** Types + fixture system. No logic, no API calls.

**Build:**
- Finalize all TypeScript types: `ReviewJob`, `FileDiff`, `FileContent`, `Finding`, `AgentResult`, `Command`, `Severity`, `InstallationConfig`
- Create a realistic test fixture folder:
  ```
  worker/fixtures/pr-001/
    pr.json           ← title, description, commit messages, head_sha
    diff.patch        ← unified diff of multiple changed files
    files/            ← full content of changed files
      src/config.js
      src/routes/users.js
      src/utils/db.js
    related/          ← 1-hop imports (unchanged files pulled for cross-file analysis)
      src/middleware/auth.js
    package.json      ← dependency manifest
    existing_comments.json
  ```
- Fixture loader: reads the folder → produces a valid `ReviewJob`

**Test:**
- Fixture loader produces correctly shaped `ReviewJob`
- All required fields present and typed correctly
- TypeScript compiles with zero errors

**Done when:** `npm run typecheck` passes, fixture loads without errors.

---

## Phase 2 — Security Agent

**What:** First agent. All 4 passes. Runs against fixture.

**Build:**
- `src/agents/workers/security.ts`
- Pass 1: Secrets scanner
  - Regex patterns: AWS/GCP/GitHub/Stripe/Twilio keys, PEM headers, JWTs, connection strings
  - Shannon entropy analysis (> 4.5 bits/char, length > 20)
  - Base64 decode before scanning
  - Skip test fixtures, mock dirs, `.example` files
  - Entropy hits → WARN. Pattern hits → HOLD.
- Pass 2: Injection surface (basic AST taint)
  - SQL injection: string concat into query calls
  - Shell injection: `exec()`/`subprocess` with non-literal args
  - XSS: user input into `innerHTML`/`dangerouslySetInnerHTML`
  - Path traversal: `fs.readFile`/`open()` with user input
- Pass 3: Dependency audit
  - Parse `dependency_manifest` for added/bumped packages
  - Mock OSV API response in tests (real call in integration)
  - Flag CVEs at CVSS 7.0+, yanked packages, packages < 30 days old
- Pass 4: Auth gap analysis
  - Detect new route handlers not wrapped in auth middleware
  - Flag `Access-Control-Allow-Origin: *` with `credentials: true`
  - Flag `algorithms: 'none'` in JWT decode
  - Uses `related_files` for cross-file middleware check

**Fixture additions:** Add known vulnerability examples to `pr-001` — a hardcoded API key, a raw SQL string, a new route without auth middleware.

**Test:**
- Each pass finds its planted finding
- Severities are correct (HOLD vs WARN)
- Clean code produces zero findings
- Returns valid `AgentResult` shape

**Done when:** All 4 passes find what they should, miss what they should.

---

## Phase 3 — Quality Agent

**What:** Second agent. All 4 passes.

**Build:**
- `src/agents/workers/quality.ts`
- Pass 1: Logic review heuristics
  - Off-by-one in loop bounds and slice indices
  - Unreachable code after `return`
  - Always-true/false conditions
  - Null deref on nullable types
- Pass 2: Complexity scoring
  - Cyclomatic complexity per changed function (AST walk)
  - Thresholds: ≤10 pass, 11–20 SUGGEST, >20 WARN
- Pass 3: Test coverage gaps
  - New functions with no corresponding test file/case
  - New branches with only one side tested
- Pass 4: Performance flags
  - DB calls inside loops (N+1)
  - `while(true)` without break condition
  - `.collect()` / array spread on large iterators
  - Blocking I/O in async handlers

**Fixture additions:** Add a high-complexity function, a loop with a DB call, a function with no tests.

**Test:**
- Each pass finds its planted issue
- Severities correct (WARN vs SUGGEST)
- Clean code produces zero findings
- Perf-only mode (`review:perf`) skips non-perf passes

**Done when:** All 4 passes find what they should, clean code passes clean.

---

## Phase 4 — Blast Radius Agent

**What:** Static import graph traversal. No LLM.

**Build:**
- `src/agents/workers/blast-radius.ts`
- Import parser: extract `import`/`require` statements (JS/TS), `import` (Python)
- Graph builder: maps file → what it imports
- Traversal: from changed files, walk outward N hops, collect all affected files
- Export diff: AST compare exported signatures before/after — flag if changed
- Test file detection: find test files in affected set
- Config/env var detection: regex scan diff for new/changed env vars
- Migration detection: check if any migration files are in the diff
- Route detection: find affected route handlers in traversal result
- Import graph cached by `(repo, commit_sha)` — in Phase 4 just build it fresh each time, caching comes in Phase 8

**Fixture additions:**
```
worker/fixtures/pr-001/repo-map.json   ← full list of repo files with their imports
```
Example: `src/utils/db.js` is imported by `src/routes/users.js`, `src/routes/payments.js`, `src/services/export.js`.

**Test:**
- Changing `src/utils/db.js` → traversal finds all 3 importers
- Exported function signature change → flagged as interface break risk
- No changed exports → no interface flag
- Returns correct `blast_radius` structure

**Done when:** Traversal correctly maps affected files from fixture repo map.

---

## Phase 5 — LLM Agent

**What:** First phase with actual LLM calls.

**Build:**
- `src/agents/workers/llm.ts`
- Task A: Auto-summary
  - System prompt: ask for what/why/changed/NOT changed in JSON
  - Input: diff + PR metadata
  - Output: `{ what, why, changed: string[], not_changed: string[] }`
- Task B: Intent questions
  - System prompt: ask for 2–5 unanswered questions as JSON
  - Input: diff + PR description + existing comments (for dedup)
  - Output: `[ { question: string, justification: string } ]`
- Both tasks run in parallel (two concurrent LLM calls)
- Provider routing: pick correct AI SDK provider from `llm_provider` field

**Test:**
- Run against `pr-001` fixture with a real API key (set via env var in test)
- Assert output matches the JSON schema — not the content, the shape
- Assert both tasks complete and return parseable JSON
- Assert parallel execution (both calls fire simultaneously)
- Test provider routing: mock each provider, assert correct one is called

**Done when:** Both tasks return valid structured JSON from a real LLM call.

---

## Phase 6 — Historical Agent

**What:** Git history analysis. No LLM, no GitHub API.

**Build:**
- `src/agents/workers/historical.ts`
- Input: changed file paths + `git_log` from fixture
- Find past commits touching the same files (last 2 years window)
- Correlate: did a bug-fix PR follow within 7 days? → WARN
- Surface unresolved past review comments on same functions
- Flag recurring vulnerability class in same file (fixed + re-introduced > once)

**Fixture additions:**
```
worker/fixtures/pr-001/git_log.json   ← list of past commits touching changed files
  [
    {
      "sha": "abc123",
      "date": "2025-11-01",
      "message": "fix: patch SQL injection in db.js",
      "files": ["src/utils/db.js"],
      "followed_by_bugfix": true,
      "days_until_bugfix": 3
    }
  ]
```

**Test:**
- File with past bug-fix within 7 days → WARN flagged
- Recurring vulnerability in same file → WARN with links
- Clean history → no findings
- Returns valid `AgentResult`

**Done when:** Historical patterns detected correctly from fixture git log data.

---

## Phase 7 — Orchestrator + Formatter

**What:** Wire all agents together. No GitHub yet. Pure logic.

**Build:**
- `src/orchestrator/router.ts` — command → agent set mapping
  ```
  review          → [Security, Quality, LLM, BlastRadius, Historical]
  review:security → [Security]
  review:perf     → [Quality(perf)]
  summarize       → [LLM(summary)]
  ask             → [LLM(conversational)]
  blast-radius    → [BlastRadius]
  re-review       → all + delta mode
  ```
- `src/orchestrator/dispatcher.ts` — run selected agents in parallel, collect `AgentResult[]`
- `src/orchestrator/aggregator.ts` — merge findings, sort by severity (HOLD → WARN → SUGGEST → PASS)
- `src/orchestrator/formatter.ts` — produce final comment strings
  - Split: inline findings (have file + line) vs top-level (everything else)
  - Build inline comment payloads: `[ { path, line, body } ]`
  - Build top-level markdown string: HOLD → WARN → SUGGEST → questions → summary → blast radius

**Test:**
- Mock all agents with known `AgentResult` outputs
- Assert correct agents are called for each command (and only those)
- Assert aggregation: findings sorted correctly, severities preserved
- Assert formatter: inline findings correctly separated, markdown structure correct
- Assert `/re-review` delta: given prev findings + new findings, delta is correct
- Assert parallel dispatch: all agents fire simultaneously (use timing or mock)

**Done when:** Full pipeline from `ReviewJob` → `{ inline: [], topLevel: string }` works correctly for every command.

---

## Phase 8 — GitHub Context Assembler

**What:** First GitHub API integration. Transforms GitHub API responses into `ReviewJob`.

**Build:**
- `src/github/context.ts`
- Fetch diff: `GET /repos/{owner}/{repo}/pulls/{id}/files`
- Fetch PR metadata: `GET /repos/{owner}/{repo}/pulls/{id}`
- Fetch changed file contents: `GET /repos/{owner}/{repo}/contents/{path}?ref={sha}` per file
- Fetch 1-hop imports: parse changed files for import statements → fetch those files too (`related_files`)
- Fetch dependency manifest: `package.json` / `requirements.txt` / `go.mod`
- Fetch existing review comments: `GET /repos/{owner}/{repo}/pulls/{id}/comments`
- Assemble → `ReviewJob`

**Test:**
- Mock Octokit with fixture data
- Assert `ReviewJob` is assembled correctly from mocked responses
- Assert `related_files` correctly fetches 1-hop imports
- Assert missing optional fields (no `package.json`) handled gracefully

**Done when:** Context assembler produces a valid `ReviewJob` from mocked GitHub API responses.

---

## Phase 9 — GitHub Comment Poster

**What:** Production output path. Posts review to GitHub.

**Build:**
- `src/github/poster.ts`
- Post provisional comment: `POST /repos/{owner}/{repo}/issues/{id}/comments`
  - Store returned `comment_id`
- Post inline review (batched): `POST /repos/{owner}/{repo}/pulls/{id}/reviews`
  - `event: "COMMENT"`, `comments: [ { path, line, body } ]`
- Post top-level summary: `POST /repos/{owner}/{repo}/issues/{id}/comments`
- Delete provisional comment: `DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}`
- Error handling: API key failure → classify error → queue email alert → silent to GitHub

**Test:**
- Mock Octokit, assert correct endpoints called
- Assert inline comments batched into single review call
- Assert provisional comment created then deleted
- Assert zero GitHub API calls on LLM auth failure (email path only)

**Done when:** Correct GitHub API calls made with correct payloads, verified via mocks.

---

## Phase 10 — Webhook Handler

**What:** Entry point. Receives GitHub events, routes everything.

**Build:**
- `src/webhook/handler.ts`
- HMAC-SHA256 signature validation (reject if invalid)
- Event type routing:
  - `pull_request.ready_for_review` → auto: summarize + security
  - `issue_comment.created` → parse slash command
  - `pull_request.synchronize` → silent security scan
- Slash command parser: extract command + args from comment body
- Confirm actor is a repo collaborator (from webhook payload permissions)
- KV lookup: `install:{installation_id}` → API key + provider
- Generate `job_id`, call context assembler, run orchestrator, post result
- Return `200` immediately after enqueue (before processing — Workers handle async)

**Test:**
- Send mock webhook payloads to `wrangler dev` local server
- Assert invalid HMAC → 401
- Assert unknown event type → 200 no-op
- Assert slash command parsed correctly from comment body
- Assert correct command routed per event type
- Assert non-collaborator comment → ignored

**Done when:** All event types handled correctly with local `wrangler dev`.

---

## Phase 11 — KV + Installation Config

**What:** State layer. API keys and job state.

**Build:**
- `src/kv/installation.ts`
  - `getInstallation(id)` → `InstallationConfig`
  - `setInstallation(id, config)` → store encrypted
  - API key encrypted at rest (AES-256 via Web Crypto API — available in Workers)
- `src/kv/jobs.ts`
  - `saveFindings(job_id, findings, ttl=4h)` → store for `/re-review`
  - `getFindings(job_id)` → `AgentResult[] | null`
- `src/api/setup.ts` — POST endpoint for settings page
  - Receives installation_id + api_key + provider + email
  - Validates key format
  - Stores via `setInstallation()`

**Test:**
- Mock KV namespace
- Assert API key encrypted before write, decrypted on read
- Assert TTL set correctly on job findings
- Assert `getFindings` returns null after TTL (mock expiry)
- Assert setup endpoint stores config correctly

**Done when:** Config round-trips correctly through KV with encryption.

---

## Phase 12 — E2E Integration

**What:** Full flow end to end. First real GitHub test.

**Build:**
- E2E test: fixture → all agents → orchestrate → format → assert comment string (no GitHub posting)
- Wire real GitHub App credentials in `wrangler.toml` secrets
- Deploy to Cloudflare Workers (`wrangler deploy`)
- Create a test repo, open a test PR with known issues
- Install the GitHub App on the test repo
- Type `/review` in the PR comment
- Observe the posted review comment

**Test:**
- E2E unit: full pipeline with all agents produces expected comment structure
- Live: review comment appears in test PR within 30 seconds
- Live: HOLD findings appear as inline comments on correct lines
- Live: top-level comment has correct sections

**Done when:** `/review` on a real PR produces a correctly structured review comment with real findings.

---

## Summary

| Phase | What | External deps |
|---|---|---|
| 1 | Types + fixtures | None |
| 2 | Security Agent | None (mock OSV) |
| 3 | Quality Agent | None |
| 4 | Blast Radius Agent | None |
| 5 | LLM Agent | LLM API key |
| 6 | Historical Agent | None |
| 7 | Orchestrator + Formatter | None |
| 8 | GitHub Context Assembler | GitHub API (mocked) |
| 9 | GitHub Comment Poster | GitHub API (mocked) |
| 10 | Webhook Handler | Wrangler dev |
| 11 | KV + Installation Config | KV (mocked) |
| 12 | E2E Integration | GitHub App + real PR |

Phases 1–7: zero external dependencies. Build and test entirely locally.
Phase 5 onwards: needs an LLM API key for the LLM agent tests only.
Phase 12: first time real GitHub is involved.
