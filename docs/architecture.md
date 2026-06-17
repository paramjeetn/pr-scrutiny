# PR Scrutiny — Architecture

**v2.0 · June 2026**

---

## 1. System Architecture

### The big picture

GitHub does not run our code. It fires HTTP webhooks to a URL we own. Everything below that URL is our system.

```
┌─────────────────────────────────────────────────────────┐
│                        GITHUB                           │
│                                                         │
│   Repo → GitHub App installed                           │
│        → Webhook fires on PR events                     │
│        → GitHub API available for reads/writes          │
└───────────────────┬─────────────────────────────────────┘
                    │ POST /webhook
                    ▼
┌─────────────────────────────────────────────────────────┐
│              CLOUD RUN (TypeScript/Node.js)             │
│                                                         │
│   Webhook Handler                                       │
│        → validate HMAC → parse → respond 200            │
│        → dispatch async job (Cloud Tasks or in-process) │
│                                                         │
│   Job Worker                                            │
│        → Context Assembler → ReviewJob                  │
│        → Orchestrator → Agents (parallel)               │
│        → Result Aggregator → GitHub Comment API         │
│                                                         │
│   Storage: Firestore (install config, job state)        │
│   Secrets: GCP Secret Manager                           │
└─────────────────────────────────────────────────────────┘
```

### Runtime: Google Cloud Run

One container image. Scales to zero when idle. Spins up on webhook, processes, dies.

| Property | Value |
|---|---|
| Runtime | Node.js 22 (full runtime, no sandbox restrictions) |
| Language | TypeScript |
| Request timeout | Up to 60 min (configurable). We set 120s. |
| CPU | No CPU time limit — full CPU for duration of request |
| Concurrency | 1 request per instance (isolates jobs from each other) |
| Scale to zero | Yes — no cost when idle |
| Cold start | ~1-2s (irrelevant — webhook processing takes 15-30s) |
| Local dev | `docker run` or `tsx watch` — identical behavior to prod |
| Deploy | `gcloud run deploy` or Cloud Build on git push |

Why Cloud Run over Cloudflare Workers:
- No CPU time limit. Static analysis (regex, entropy, import graph parsing) can take seconds on large diffs. Workers cap at 30s CPU.
- Full Node.js. Any npm package works — real AST parsers, full Octokit, no API subset restrictions.
- Container-based. Local testing is `docker run`, not a custom runtime emulator.
- Native GCP ecosystem. Firestore, Secret Manager, Cloud Tasks — all first-party, no adapter layers.

### GitHub App

The GitHub App is a registration on GitHub's side. It provides:

- A webhook URL (points to our Cloud Run service)
- OAuth permissions for reading/writing to repos
- An Installation ID per org/repo that installs it
- Short-lived Installation Access Tokens we use to call the GitHub API

The App itself has no code. It is a config entry on GitHub that routes events to us.

**Permissions we request:**

| Permission | Access | Why |
|---|---|---|
| Pull requests | Read + Write | Read diff, post review comments |
| Contents | Read | Fetch full file contents |
| Metadata | Read | Repo info, member list |
| Issues | Read | Linked issues for context |
| Checks | Read | CI result correlation |

The agent cannot merge, push, or modify files. Ever.

### Installation and onboarding flow

```
1. User clicks "Install" on our GitHub App page
        ↓
2. GitHub asks them to select repos (all or specific)
        ↓
3. GitHub creates an Installation ID for their org
        ↓
4. GitHub redirects to our callback URL:
   https://our-domain.com/setup?installation_id=12345
        ↓
5. Our settings page opens — user pastes their API key
   (Anthropic / OpenAI / Gemini)
   and optionally their email for error alerts
        ↓
6. We store encrypted in Firestore:
   installations/{installation_id} → { api_key, provider, email }
        ↓
7. Done. All repos in that installation are now active.
```

From this point on, every webhook from that installation carries the `installation_id`. We look up their key and use it.

### Webhook reception

Every relevant GitHub event fires a POST to our `/webhook` endpoint.

Events we handle:

| GitHub event | Action | What we do |
|---|---|---|
| `pull_request` | `opened` | — (wait for explicit command or auto-trigger) |
| `pull_request` | `ready_for_review` | Auto: run summarize + security |
| `pull_request` | `synchronize` (push) | If prior review exists: re-review in delta mode |
| `issue_comment` | `created` | Parse for slash command |
| `pull_request_review_comment` | `created` | Parse for /ask reply |

On receipt:

```
1. Validate HMAC-SHA256 signature (prevents spoofed webhooks)
2. Parse installation_id, repo, pr_number, event type, actor
3. Confirm actor is a repo collaborator (prevents outsiders triggering reviews)
4. Check idempotency key — skip if this webhook already processed
5. Parse slash command if present
6. Return 200 immediately (GitHub requires fast acknowledgement)
7. Continue processing asynchronously (Cloud Run keeps the instance alive)
8. Post provisional comment: "Review in progress..."
9. Run orchestrator → agents → post results
10. Delete provisional comment
```

### Job deduplication and idempotency

GitHub webhook delivery is at-least-once. The same event can arrive multiple times. Concurrent `/review` commands can overlap.

**Idempotency key:** `{event_id}` from the `X-GitHub-Delivery` header. Before processing, check Firestore:

```
idempotency/{delivery_id} → { status: "processing" | "done", created_at }
```

- If key exists and status is `done` → return 200, skip.
- If key exists and status is `processing` → return 200, skip (another instance is handling it).
- If key does not exist → write `processing`, continue.
- On completion → update to `done`. TTL: 24h (Firestore TTL policy).

**Duplicate command protection:** If someone types `/review` twice in quick succession, two webhooks fire. The idempotency key handles this — same `X-GitHub-Delivery` for different comments will have different delivery IDs, but we also check:

```
jobs/{repo}:{pr_number}:{head_sha} → { status, started_at }
```

If a job for the same PR + same commit is already `running`, skip the second one and reply: "Review already in progress."

### Multi-tenancy

GitHub handles the hard part. Every webhook payload contains:

```json
{
  "installation": { "id": 12345 },
  "repository": { "full_name": "acme/repo-a" },
  "pull_request": { "number": 42 },
  "sender": { "login": "bob" }
}
```

We use `(installation_id, repo, pr_number)` as the job key. Cloud Run concurrency is set to 1, so each instance handles exactly one job. No shared state, no race conditions.

### Error handling — API key failures

API key errors never produce a GitHub comment. They go to email.

```
LLM API call fails
        ↓
Classify the error:
  ├── 401 Invalid key      → email: "Your API key is invalid or revoked"
  ├── 429 Rate limit       → email: "Rate limit hit on repo X, PR #42"
  ├── 402 Quota exceeded   → email: "Billing limit reached on your API key"
  └── 5xx Provider error   → retry twice, then email: "Provider error, review skipped"
        ↓
No comment posted to GitHub.
Silent from the PR's perspective.
One email per incident — no repeat spam.
```

---

## 2. Agent Architecture

### Core principle

The agent system is built around a single data contract: the `ReviewJob`. Every agent reads from it. No agent talks directly to GitHub. No agent knows about webhooks or installations. The agent core is pure logic.

```
GitHub API  ──►  Context Assembler  ──►  ReviewJob  ──►  Agents
(production)

Local fixture ──►  Fixture Loader   ──►  ReviewJob  ──►  Agents
(dev / test)
```

The agents are identical in both modes. Only the source of the `ReviewJob` changes.

### ReviewJob — the data contract

Everything an agent needs to do its job:

```typescript
interface ReviewJob {
  // identity
  job_id: string
  command: Command
  question?: string           // only for /ask

  // the diff — always multiple files, one entry per changed file
  diff: FileDiff[]

  // PR context
  pr: {
    number: number
    title: string
    description: string
    commit_messages: string[]
    base_branch: string
    head_sha: string
    previous_head_sha?: string  // for /re-review delta
    repo: string                // "owner/repo"
  }

  // full content of every changed file
  changed_files: FileContent[]

  // unchanged files pulled in for cross-file analysis (1 hop from changed files)
  // e.g. auth middleware, shared utils — needed for injection and auth gap passes
  related_files: FileContent[]

  // optional context
  dependency_manifest?: string  // package.json / requirements.txt / go.mod
  existing_comments?: string[]  // for LLM deduplication

  // config
  llm_api_key: string
  llm_provider: "anthropic" | "openai" | "google"

  // github auth
  installation_id: number
}

type Command =
  | "review"
  | "review:security"
  | "review:perf"
  | "summarize"
  | "ask"
  | "blast-radius"
  | "re-review"

interface FileDiff {
  path: string
  additions: number
  deletions: number
  patch: string            // unified diff format
}

interface FileContent {
  path: string
  content: string
}
```

### Diff size limits and token budget

Large PRs can blow up LLM costs and processing time. We enforce limits at two levels.

**Context Assembler limits (before agents run):**

| Limit | Value | What happens when exceeded |
|---|---|---|
| Max changed files | 25 files | Prioritize by: security-sensitive paths first (`routes/`, `auth/`, `config/`, `middleware/`), then by change volume. Remaining files listed in summary as "N files skipped." |
| Max diff lines | 500 lines total | Same prioritization. Truncated files get a note in the review. |
| Max single file size | 1000 lines | File content truncated to first 1000 lines with a note. |
| Max related_files | 10 files | Only fetch the most-imported related files. |

**LLM Agent token budget:**

| Budget | Value |
|---|---|
| Max context per LLM call | ~12k tokens of diff + file content |
| Strategy when exceeded | Keep full changed hunks (the `+`/`-` lines). Summarize unchanged context between hunks. Drop file content for files with small diffs (<5 lines changed) — the patch alone is enough. |
| Summary task | Gets full diff (it needs the big picture). If still over budget, chunk into 2 calls: first half of files → partial summary, second half → merge. |
| Intent questions task | Gets diff + PR description only (no file contents needed). Cheapest call. |

**Static agents (Security, Quality, BlastRadius):** No token budget needed. They process programmatically. Cost is CPU time, not dollars. CPU is not a concern on Cloud Run.

### Analysis scope — per-file vs cross-file

A PR diff always spans multiple files. Some passes analyze each file independently; others require cross-file context.

| Pass | Scope | Reason |
|---|---|---|
| Secrets scanner | Per-file | Secrets live in one place |
| Complexity | Per-file | Function is self-contained |
| Performance | Per-file | N+1, unbounded loops visible in one file |
| Injection surface | Cross-file | Source (user input) and sink (DB/shell call) often in different files |
| Auth gaps | Cross-file | Middleware defined in one file, route handler in another |
| Test coverage | Per-file + cross | New function in `src/X.js`, test may be in `tests/X.test.js` |
| Blast radius | Whole repo | Import graph is global |

**How `related_files` are assembled (Context Assembler, Phase 3):**

```
For each changed file:
  1. Read the file content
  2. Parse import/require statements (regex-based, not full AST)
     - JS/TS: import ... from '...', require('...')
     - Python: import ..., from ... import ...
     - Go: import "..."
  3. Resolve relative paths to absolute repo paths
  4. Deduplicate across all changed files
  5. Fetch up to 10 most-referenced files via GitHub Contents API
```

This is enough to trace injection paths (request → handler → DB call) and verify middleware coverage (route file imports auth middleware) without pulling the entire repo.

### Orchestrator

The orchestrator is the entry point for every job. It does four things: route the command, slice context, dispatch agents, aggregate results.

```
ReviewJob
    ↓
┌─────────────────────────────────────────┐
│              ORCHESTRATOR               │
│                                         │
│  1. Command Router                      │
│     → decide which agents to run        │
│                                         │
│  2. Context Slicer                      │
│     → give each agent its relevant data │
│                                         │
│  3. Agent Dispatcher                    │
│     → run selected agents in parallel   │
│     → enforce per-agent timeout         │
│                                         │
│  4. Result Aggregator                   │
│     → merge + deduplicate findings      │
│     → format output                     │
└─────────────────────────────────────────┘
    ↓
AgentResult[]
    ↓
Formatted comment string
```

### Command router

Maps each command to an agent set. Agents not in the set do not run — no wasted compute.

```
/review          → [SecurityAgent, QualityAgent, LLMAgent, BlastRadiusAgent]
/review security → [SecurityAgent]
/review perf     → [QualityAgent(perf-only)]
/summarize       → [LLMAgent(summary)]
/ask             → [LLMAgent(conversational)]
/blast-radius    → [BlastRadiusAgent]
/re-review       → [SecurityAgent, QualityAgent, LLMAgent, BlastRadiusAgent] + delta mode

Auto: draft→ready       → [SecurityAgent, LLMAgent(summary)]
Auto: 24h no reviewer   → [LLMAgent(summary)]
Auto: force-push        → [SecurityAgent] (secrets-only, silent — post only if new HOLD found)
```

### Agent timeouts and partial results

Each agent runs with a timeout enforced by the orchestrator via `Promise.race`. If an agent exceeds its timeout, the orchestrator collects whatever results are available from the other agents and posts them.

| Agent | Timeout | Why |
|---|---|---|
| SecurityAgent | 30s | Regex + entropy + OSV API call. Should be fast. |
| QualityAgent | 30s | Pattern matching + heuristics. |
| LLMAgent | 60s | LLM calls are the bottleneck. Provider latency varies. |
| BlastRadiusAgent | 30s | GitHub Trees API + import parsing. |

**Partial result behavior:**

```
All agents dispatched in parallel via Promise.allSettled
        ↓
Wait up to max(agent timeouts) = 60s
        ↓
Collect results:
  ├── fulfilled agents → include findings normally
  └── timed out / errored agents → add a note in the top-level comment:
      "⚠ LLM Agent timed out — summary and questions unavailable for this review."
        ↓
Post whatever we have. A partial review is better than no review.
```

### The agents

Each agent receives a context slice and returns a structured `AgentResult`.

```typescript
interface AgentResult {
  agent: string
  findings: Finding[]
  metadata?: Record<string, unknown>  // summary text, questions array, blast_radius, etc.
  trace: AgentTrace
}

interface Finding {
  severity: "HOLD" | "WARN" | "SUGGEST" | "PASS" | "QUESTION"
  file?: string
  line?: number
  code?: string
  message: string
  remediation?: string
}

interface AgentTrace {
  agent: string
  duration_ms: number
  finding_count: number
  error?: string        // if agent failed or timed out
}
```

---

#### Security Agent

Runs four independent passes. All pattern-based heuristics in v1 — no AST parsing.

```
Context slice: diff + full file contents + dependency manifest + related_files
        ↓
┌───────────────────────────────────────────────┐
│              SECURITY AGENT                   │
│                                               │
│  Pass 1: Secrets Scanner                      │
│    → regex for known key patterns             │
│    → Shannon entropy analysis (>4.5, len >20) │
│    → base64 decode before scanning            │
│    → skip test fixtures, .example files       │
│                                               │
│  Pass 2: Injection Surface                    │
│    → regex for dangerous sinks                │
│      (exec, eval, raw SQL, innerHTML, etc.)   │
│    → check if argument is a literal or        │
│      a variable (string heuristic)            │
│    → cross-file: check if sink's input comes  │
│      from request params (grep related_files) │
│                                               │
│  Pass 3: Dependency Audit                     │
│    → parse dependency_manifest for packages   │
│    → query OSV API for CVEs at CVSS ≥ 7.0    │
│    → flag yanked/deprecated/abandoned pkgs    │
│                                               │
│  Pass 4: Auth & Access Control                │
│    → find new route handlers in diff          │
│    → grep for auth middleware import/usage     │
│    → flag routes without auth wrapping        │
│    → flag wildcard CORS, JWT alg:none         │
│                                               │
│  (all 4 passes run in parallel)               │
└───────────────────────────────────────────────┘
        ↓
findings[]  — severity: HOLD or WARN
```

**v1 scope (honest):** Pattern-based heuristics using regex and string matching. Catches the obvious cases — hardcoded secrets, direct `eval(userInput)`, missing auth middleware, known CVEs. Does NOT do full taint analysis or AST-level data flow tracking. That is a v2 goal (lightweight AST for JS/TS only using babel/acorn parser).

HOLD findings block. WARN findings flag but don't block. Entropy-only hits always WARN, never HOLD.

---

#### Quality Agent

Runs four passes. Pattern-based heuristics + simple metrics. Can be restricted to perf-only via command routing.

```
Context slice: diff + full file contents
        ↓
┌───────────────────────────────────────────────┐
│              QUALITY AGENT                    │
│                                               │
│  Pass 1: Logic Review                         │
│    → off-by-one patterns in loops/slices      │
│    → null/undefined access patterns           │
│    → always-true/false conditions             │
│    → shared mutable state across await        │
│                                               │
│  Pass 2: Complexity Analysis                  │
│    → count branching keywords per function    │
│      (if/else/switch/case/for/while/catch/&&) │
│    → thresholds: ≤10 pass, 11-20 suggest, >20│
│                                               │
│  Pass 3: Test Coverage Gaps                   │
│    → find new functions in diff               │
│    → check for corresponding test file        │
│    → only flag new code, not existing untested│
│                                               │
│  Pass 4: Performance Flags                    │
│    → DB calls inside loops (N+1 patterns)     │
│    → while(true) without break/return         │
│    → blocking I/O in async context            │
│    → .collect() / .toArray() on large streams │
│                                               │
│  (all 4 passes run in parallel)               │
└───────────────────────────────────────────────┘
        ↓
findings[]  — severity: WARN or SUGGEST
```

---

#### LLM Agent

LLM-powered analysis using Vercel AI SDK. For `/review`, both tasks run in parallel. For focused commands (`/summarize`, `/ask`), only the relevant task runs.

```
Context slice: diff + PR data + existing comments
LLM provider: customer's key via Vercel AI SDK (Anthropic / OpenAI / Google)
        ↓
┌────────────────────────────────────────┐
│             LLM AGENT                  │
│                                        │
│  Task A: Auto-Summary                  │
│    → what / why / changed / NOT changed│
│    → structured JSON output            │
│                                        │
│  Task B: Intent Questions              │
│    → 2-5 unanswered questions          │
│    → dedup against existing comments   │
│    → structured JSON output            │
│                                        │
│  (A and B run in parallel)             │
└────────────────────────────────────────┘
        ↓
metadata: { summary, questions[] }
```

For `/ask`: single LLM call with the question + full context. Returns conversational reply, not structured findings.

Each task has its own focused system prompt. Output is structured JSON via Vercel AI SDK's `generateObject()` with Zod schemas — not free text.

**Provider abstraction:** Vercel AI SDK handles this. Same code, swap provider:

```typescript
import { anthropic } from "@ai-sdk/anthropic"
import { openai } from "@ai-sdk/openai"
import { google } from "@ai-sdk/google"

// provider selected at runtime based on customer config
const model = getModel(job.llm_provider, job.llm_api_key)
const result = await generateObject({ model, schema, prompt })
```

---

#### Blast Radius Agent

Pure static analysis. No LLM calls. Traverses the repo's import graph to map everything affected by the changed files.

```
Context slice: changed file paths + full repo file tree (GitHub Trees API)
        ↓
┌────────────────────────────────────────────┐
│           BLAST RADIUS AGENT               │
│                                            │
│  Step 1: Fetch repo file tree              │
│    → GitHub Trees API (single API call)    │
│    → returns all file paths in the repo    │
│                                            │
│  Step 2: Build import graph                │
│    → for files in the tree, fetch content  │
│      of files that could import changed    │
│      modules (match by directory/name)     │
│    → parse import/require statements       │
│      (regex-based, same as related_files)  │
│                                            │
│  Step 3: Find direct importers             │
│    → which files import changed modules?   │
│                                            │
│  Step 4: Walk N hops outward               │
│    → who imports those files?              │
│    → stop at entry points or N=2 hops      │
│                                            │
│  Step 5: Classify findings                 │
│    → test files in affected set?           │
│    → env vars / config keys changed?       │
│    → migrations in diff?                   │
│    → route handlers affected?              │
└────────────────────────────────────────────┘
        ↓
metadata: {
  blast_radius: {
    direct_importers: string[]
    transitive_importers: string[]
    tests_affected: string[]
    tests_missing: string[]     // affected files with no test in the set
    config_changes: string[]
    migrations: boolean
    routes_affected: string[]
  }
}
```

The result is a structured table — deterministic, cheap, no LLM needed.

**Optimization for large repos:** The full import graph is expensive. Strategy:
1. Fetch the tree (1 API call, returns all paths).
2. Only fetch file contents for files whose path could plausibly import a changed module (same directory, parent directory, common import directories like `src/`, `lib/`).
3. Cap at 100 files fetched for graph building. Beyond that, report "Blast radius: partial (repo too large for full traversal)."

---

### Full parallel flow for `/review`

```
ReviewJob (command: "review")
        ↓
Orchestrator: route → 4 agents
        ↓
Assemble base context (once, shared)
        ↓
┌──────────────────────────────────────────────────────────┐
│  Promise.allSettled — parallel execution with timeouts   │
│                                                          │
│  SecurityAgent (30s) ──────────────► findings[]          │
│                                                          │
│  QualityAgent (30s) ───────────────► findings[]          │
│                                                          │
│  LLMAgent (60s)                                          │
│    ├── Task A (summary) ───────────► metadata.summary    │
│    └── Task B (questions) ─────────► metadata.questions  │
│                                                          │
│  BlastRadiusAgent (30s)                                  │
│    └── import graph traversal ─────► metadata.blast_radius│
│                                                          │
└──────────────────────────────────────────────────────────┘
        ↓
Aggregator: merge all findings[], deduplicate, sort by severity
        ↓
Formatter: build comment string
  ├── HOLD findings (inline + top-level)
  ├── WARN findings (inline + top-level)
  ├── SUGGEST findings (top-level only)
  ├── Questions (top-level)
  ├── Summary (top-level)
  ├── Blast radius table (top-level)
  └── Agent trace (timing, errors — collapsed section)
        ↓
GitHub Comment API
```

### Finding deduplication

Multiple agents can flag the same line. The aggregator deduplicates before posting.

**Dedup key:** `(file, line)`

**Rules:**
1. If two findings have the same `(file, line)`, keep the one with the higher severity. `HOLD > WARN > SUGGEST`.
2. If same severity, merge messages: "Security: ... | Quality: ..."
3. Findings without a file/line (e.g. dependency audit, missing test file) are never deduped — they go to the top-level comment.
4. `PASS` findings are never deduped — each agent's PASS is listed independently.

### Data tiers per command

Each command fetches only what it needs. Nothing more.

| Data | How fetched | Commands that need it |
|---|---|---|
| Diff (patch) | GitHub API `/pulls/{id}/files` | All |
| PR metadata (title, description, commits) | GitHub API `/pulls/{id}` | All |
| Full content of changed files | GitHub API `/contents/{path}` per file | All except `/summarize` |
| Related files (1-hop imports) | Parse imports → GitHub API `/contents/{path}` | `/review`, `/review security` |
| Dependency manifest | GitHub API `/contents/package.json` etc. | `/review`, `/review security` |
| Full repo file tree | GitHub Trees API `/git/trees/{sha}?recursive=1` | `/blast-radius`, `/review` |
| Existing review comments | GitHub API `/pulls/{id}/comments` | `/ask`, LLM dedup |
| Previous job findings | Firestore | `/re-review` only |

### Re-review and delta mode

**Continuous commits to a PR** — a dev might push 5 commits while fixing things. Auto-running a full review on every push floods the PR.

```
Push to PR branch (synchronize event)
        ↓
Is there a prior review on this PR? (check Firestore)
  ├── No  → do nothing (wait for explicit /review)
  └── Yes → run SecurityAgent only, silently
              ├── No new HOLD findings → post nudge:
              │   "New commits since last review. /re-review when ready."
              └── New HOLD found → post immediately, don't wait
```

On `/re-review`:

```
Load previous job findings from Firestore
        ↓
Run all agents fresh against latest commit
        ↓
Diff new findings vs previous findings:
  dedup key: (file, line, message_hash)
  ├── resolved: in prev, not in new
  ├── new: in new, not in prev
  └── unchanged: in both
        ↓
Post delta comment only:
"S-01 resolved. S-02 still open. 1 new SUGGEST finding."
```

Full review is not reposted. Only the delta.

---

## 3. Observability

Every job produces a `JobTrace` that is logged and optionally included in the review comment (collapsed section).

```typescript
interface JobTrace {
  job_id: string
  repo: string
  pr_number: number
  command: Command
  head_sha: string
  total_duration_ms: number
  context_assembly_ms: number
  agents: AgentTrace[]        // one per agent that ran
  diff_stats: {
    files_changed: number
    files_skipped: number     // if over limit
    total_additions: number
    total_deletions: number
  }
  llm_calls: {
    provider: string
    model: string
    total_input_tokens: number
    total_output_tokens: number
  }
  posted: boolean             // did we successfully post to GitHub?
  error?: string              // top-level error if job failed
}
```

**Where it goes:**
- Cloud Run structured logging (JSON to stdout → Cloud Logging picks it up automatically).
- Collapsed section in the GitHub review comment: "Agent trace: Security 420ms (3 findings), Quality 380ms (1 finding), LLM 12.4s (summary + 3 questions), BlastRadius 890ms."
- Firestore: `job_traces/{job_id}` with 7-day TTL. Queryable for debugging.

---

## 4. Storage

```
┌──────────────────────────────────────────────────────┐
│                    FIRESTORE                         │
│                                                      │
│  installations/{installation_id}  (persistent)       │
│    → api_key (encrypted), provider, email, active    │
│                                                      │
│  jobs/{repo}:{pr_number}:{head_sha}  (TTL: 4h)      │
│    → status: queued|running|done|fail                │
│    → findings: AgentResult[]  (for /re-review delta) │
│    → trace: JobTrace                                 │
│                                                      │
│  idempotency/{delivery_id}  (TTL: 24h)              │
│    → status: processing|done                         │
│                                                      │
│  cve_cache/{package}:{version}  (TTL: 6h)           │
│    → OSV + GitHub Advisory results                   │
│                                                      │
│  job_traces/{job_id}  (TTL: 7d)                      │
│    → full JobTrace for debugging                     │
└──────────────────────────────────────────────────────┘
```

No code is stored persistently. Job data expires after 4 hours. The only persistent data is the installation config.

**Encryption:** API keys are encrypted at rest using GCP KMS before writing to Firestore. Decrypted in-memory per job, never logged.

---

## 5. Repo Configuration

Repos can optionally include a `.pr-scrutiny.yml` at the repo root to customize behavior.

```yaml
# .pr-scrutiny.yml — all fields optional, sensible defaults

# Files/directories to skip during analysis
ignore_paths:
  - "vendor/**"
  - "*.generated.ts"
  - "dist/**"
  - "**/*.min.js"

# Minimum severity to post (skip noise)
# "HOLD" | "WARN" | "SUGGEST"  — default: "SUGGEST"
min_severity: "WARN"

# Auto-triggers
auto_review_on_ready: true        # default: true
auto_security_on_push: true       # default: true

# Disable specific agents
disabled_agents:
  - "blast-radius"    # e.g. monorepo where import graph is too large

# LLM preferences (override installation default for this repo)
llm_provider: "anthropic"         # optional override
```

The Context Assembler fetches this file before building the `ReviewJob`. If the file doesn't exist, defaults apply. Invalid YAML is silently ignored (defaults used).

---

## 6. Posting Results to GitHub

After all agents complete, results are posted in two API calls regardless of how many findings there are.

### Inline comments — HOLD and WARN findings

All inline comments are batched into a single review object:

```
POST /repos/{owner}/{repo}/pulls/{pr_number}/reviews

{
  "commit_id": "a3f9c2b",
  "event": "COMMENT",
  "comments": [
    {
      "path": "src/config.js",
      "line": 14,
      "body": "**[S-01] HOLD — Hardcoded API key detected** (entropy 5.1)\n\nRemediation: Move to environment variable."
    },
    {
      "path": "src/routes/users.js",
      "line": 88,
      "body": "**[S-02] HOLD — New endpoint has no auth middleware**\n\nRemediation: Wrap with `requireAuth()` middleware."
    }
  ]
}
```

One API call. All inline findings posted atomically.

### Top-level comment — everything else

Summary, questions, blast radius, SUGGEST findings, PASS results, agent trace:

```
POST /repos/{owner}/{repo}/issues/{pr_number}/comments

{
  "body": "## PR Scrutiny Agent — Review\n..."
}
```

PRs are issues in GitHub's model — top-level comments go to the issues endpoint.

### Full post flow

```
AgentResult[] (all agents done, or timed out with partial results)
        ↓
Formatter splits findings:
  ├── inline[]  → HOLD + WARN with file + line
  └── toplevel  → summary, questions, blast radius, SUGGEST, PASS, trace
        ↓
Call 1: POST /pulls/{id}/reviews    (inline comments, batched)
Call 2: POST /issues/{id}/comments  (top-level comment)
        ↓
Delete provisional "Review in progress..." comment
```

### Provisional comment

When the job starts, before any analysis runs, we immediately post:

```
POST /issues/{id}/comments
{ "body": "⏳ Review in progress — results in ~30s." }
```

Store the returned `comment_id`. When results are ready, delete it and post the real comment. This gives the user immediate feedback that the agent received the command.

---

## 7. Build Phases

### Phase 1 — Agent core (no GitHub, no server)

Build and test the agents in isolation using local fixtures.

```
test-fixtures/
  pr-001-hardcoded-secret/
    diff.patch
    pr.json            ← { title, description, commit_messages, base_branch, head_sha }
    files/             ← full file contents (changed + related)
      src/config.js
      src/routes/users.js
      src/middleware/auth.js    ← related file
    package.json       ← dependency manifest
  pr-002-clean/
    ...
```

Deliverables:
- `ReviewJob` type definition
- Fixture loader: reads a fixture folder → produces a `ReviewJob`
- Security Agent (4 passes: secrets, injection, deps, auth)
- Quality Agent (4 passes: logic, complexity, test coverage, perf)
- LLM Agent (summary + intent questions)
- Blast Radius Agent (import graph from provided file tree)
- Orchestrator + command router
- Result aggregator + finding deduplication + comment formatter
- Observability: `JobTrace` + `AgentTrace`

The output of Phase 1 is a CLI tool:
```
npx tsx src/cli.ts review ./test-fixtures/pr-001-hardcoded-secret
```
That prints the formatted review to stdout. Full agent system, zero GitHub.

**Exit criteria:**
- CLI produces correct formatted output for at least 3 fixture PRs.
- Security Agent catches a hardcoded secret, a missing auth middleware, and a known CVE.
- Quality Agent flags a complex function and a missing test.
- LLM Agent produces a coherent summary and 2+ intent questions.
- Blast Radius Agent maps importers for a changed module.
- Agent timeouts work: if LLM is unreachable, partial results are printed.

### Phase 2 — Cloud Run server + webhook handling

Wrap the agent core in a Cloud Run service:

- Express/Hono HTTP server
- `POST /webhook` with HMAC-SHA256 validation
- Webhook event parsing (issue_comment, pull_request, etc.)
- Slash command parser
- Idempotency check (Firestore)
- Job deduplication (Firestore)
- Async processing after 200 response

The agents from Phase 1 do not change.

**Exit criteria:**
- Webhook endpoint validates signatures correctly.
- Slash commands are parsed from comment bodies.
- Duplicate webhooks are detected and skipped.
- Server returns 200 within 1s, continues processing asynchronously.

### Phase 3 — GitHub integration

Add the GitHub data layer:

- GitHub API client (Octokit)
- Installation token flow: sign JWT with App private key → exchange for Installation Access Token
- Context Assembler: fetches diff + files + PR data + related_files → produces `ReviewJob`
- Repo config loader: fetch `.pr-scrutiny.yml`, apply defaults
- Comment poster: formatted string → GitHub Comment API (inline + top-level)
- Provisional comment lifecycle (post → delete on completion)

The agents from Phase 1 still do not change. The only new code is the data layer.

**Exit criteria:**
- Can fetch a real PR's diff, files, and metadata from GitHub.
- Can post a review comment (inline + top-level) on a real PR.
- Installation token flow works end-to-end.
- Full pipeline: slash command on a real PR → review comment appears.

### Phase 4 — Settings site + onboarding

- Small web UI at `/setup` for post-install callback
- API key input, provider selection, email capture
- Encrypts and stores to Firestore keyed by installation_id
- Error email sender (API key failures, quota exceeded)

**Exit criteria:**
- Install flow works: GitHub App install → redirect → settings page → save key → reviews work.

---

## 8. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Google Cloud Run | Scales to zero, full Node.js, no CPU limits, container-based |
| Language | TypeScript | Types already defined, strong for this kind of infra |
| LLM SDK | Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`) | Provider-agnostic, structured output via Zod, streaming support |
| GitHub API | Octokit | Official, typed, handles auth token flow |
| HTTP server | Hono | Lightweight, works everywhere, fast |
| Storage | Firestore | Serverless, TTL support, native GCP |
| Secrets | GCP Secret Manager | For GitHub App private key, webhook secret |
| Encryption | GCP KMS | For customer API keys at rest |
| Local dev | `tsx watch` + fixtures | No infra needed for Phase 1 |
| Deploy | Cloud Build → Cloud Run | Git push → auto-deploy |

---

## 9. Open Questions

1. **LLM cost on large diffs:** Even with the 500-line limit, a full `/review` with summary + questions is 2-3 LLM calls. At ~$0.01-0.05 per call, that's fine. But should we show estimated cost in the review?
2. **Mono-repo support:** Blast radius traversal in a monorepo with 10k+ files. The 100-file cap helps, but the graph will be incomplete. Accept this or integrate with build tools (Nx, Turborepo) that know the dependency graph?
3. **Secrets scanner tuning:** How to measure and tune the entropy threshold (4.5 bits/char) without labelled data? Start with known patterns, refine based on false positive reports.

### Future (post-v1)

- **Historical Agent:** Requires GitHub Commits API per changed file path. Deferred to after Phase 3 when GitHub API is wired. Adds git history correlation, recurring bug patterns, past review comments on same functions.
- **AST-level taint analysis:** v1 is pattern-based. v2 could use babel/acorn for JS/TS to do lightweight data flow tracking for injection and auth passes.
- **IDE plugin:** `/review` against local diffs before a PR is opened.
- **Learning mode:** Per-repo threshold tuning based on which findings humans dismiss.
- **Reviewer assignment:** Suggest best reviewer based on blast radius.

---

_PR Scrutiny Agent · Architecture v2.0 · June 2026_
