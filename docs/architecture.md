# PR Scrutiny — Architecture

**v1.0 · June 2026**

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
│                   OUR SYSTEM                            │
│                                                         │
│   Webhook Receiver                                      │
│        → validate → parse → enqueue                     │
│                                                         │
│   Job Queue  →  Orchestrator  →  Agents                 │
│                                                         │
│   Result Aggregator  →  GitHub Comment API              │
└─────────────────────────────────────────────────────────┘
```

### GitHub App

The GitHub App is a registration on GitHub's side. It provides:

- A webhook URL (points to our server)
- OAuth permissions for reading/writing to repos
- An Installation ID per org/repo that installs it
- Short-lived Installation Access Tokens we use to call the GitHub API

The App itself has no code. It is a config entry on GitHub that routes events to us.

**Permissions we request:**

| Permission | Access | Why |
|---|---|---|
| Pull requests | Read + Write | Read diff, post comments |
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
   (Anthropic / OpenAI / Gemini / AWS Bedrock)
   and optionally their email for error alerts
        ↓
6. We store encrypted:
   { installation_id → { api_key, provider, email } }
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
4. Parse slash command if present
5. Enqueue job
6. Post provisional comment: "Review in progress..."
7. Return 200 immediately (GitHub requires fast acknowledgement)
```

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

We use `(installation_id, repo, pr_number)` as the job key. Jobs are fully isolated. One installation can have hundreds of concurrent PRs — each is an independent job with its own Redis state.

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
    title: string
    description: string
    commit_messages: string[]
    base_branch: string
    head_sha: string
    previous_head_sha?: string  // for /re-review delta
  }

  // full content of every changed file
  changed_files: FileContent[]

  // unchanged files pulled in for cross-file analysis (1 hop from changed files)
  // e.g. auth middleware, shared utils — needed for injection taint and auth gap passes
  related_files: FileContent[]

  // optional context
  dependency_manifest?: string  // package.json / requirements.txt / go.mod
  existing_comments?: string[]  // for LLM deduplication

  // config
  llm_api_key: string
  llm_provider: "anthropic" | "openai" | "gemini" | "bedrock"
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

### Analysis scope — per-file vs cross-file

A PR diff always spans multiple files. Some passes analyze each file independently; others require cross-file context.

| Pass | Scope | Reason |
|---|---|---|
| Secrets scanner | Per-file | Secrets live in one place |
| Complexity | Per-file | Function is self-contained |
| Performance | Per-file | N+1, unbounded loops visible in one file |
| Injection taint | Cross-file | Source (user input) and sink (DB/shell call) often in different files |
| Auth gaps | Cross-file | Middleware defined in one file, route handler in another |
| Test coverage | Per-file + cross | New function in `src/X.js`, test may be in `tests/X.test.js` |
| Blast radius | Whole repo | Import graph is global |
| Historical | Per changed file path | Git log queried per file |

For cross-file passes, `related_files` provides the necessary context — the imports of changed files fetched one hop out. This is enough to trace injection paths and verify middleware coverage without pulling the entire repo.

### Orchestrator

The orchestrator is the entry point for every job. It does four things: route the command, assemble context, dispatch agents, aggregate results.

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
│                                         │
│  4. Result Aggregator                   │
│     → merge findings[], format output  │
└─────────────────────────────────────────┘
    ↓
AgentResult[]
    ↓
Formatted comment string
```

### Command router

Maps each command to an agent set. Agents not in the set do not run — no wasted compute.

```
/review          → [SecurityAgent, QualityAgent, LLMAgent, BlastRadiusAgent, HistoricalAgent]
/review security → [SecurityAgent]
/review perf     → [QualityAgent(perf-only)]
/summarize       → [LLMAgent(summary)]
/ask             → [LLMAgent(conversational)]
/blast-radius    → [BlastRadiusAgent]
/re-review       → [SecurityAgent, QualityAgent, LLMAgent, BlastRadiusAgent, HistoricalAgent] + delta mode

Auto: draft→ready       → [SecurityAgent, LLMAgent(summary)]
Auto: 24h no reviewer   → [LLMAgent(summary)]
Auto: force-push        → [SecurityAgent] (secrets-only, silent — post only if new HOLD found)
```

### The four agents

Each agent receives a context slice and returns a structured `AgentResult`.

```typescript
interface AgentResult {
  agent: AgentName
  findings: Finding[]
  metadata?: Record<string, unknown>  // summary text, questions array, etc.
}

interface Finding {
  severity: "HOLD" | "WARN" | "SUGGEST" | "PASS" | "QUESTION"
  file?: string
  line?: number
  code?: string
  message: string
  remediation?: string
}
```

---

#### Security Agent

Runs four independent passes, all static analysis (no LLM calls):

```
Context slice: diff + full file contents + dependency manifest
        ↓
┌───────────────────────────────────┐
│         SECURITY AGENT            │
│                                   │
│  Pass 1: Secrets Scanner          │
│  Pass 2: Injection Surface        │
│  Pass 3: Dependency Audit         │
│  Pass 4: Auth & Access Control    │
│                                   │
│  (run in parallel)                │
└───────────────────────────────────┘
        ↓
findings[]  — severity: HOLD or WARN
```

Secrets scanner uses regex + entropy analysis. Injection uses AST taint tracing. Dependency audit hits OSV API. Auth pass walks route handler AST.

HOLD findings block. WARN findings flag but don't block. Entropy-only hits always WARN, never HOLD.

---

#### Quality Agent

Runs four passes, static analysis + AST. Can be restricted to perf-only via command routing.

```
Context slice: diff + full file contents
        ↓
┌───────────────────────────────────┐
│          QUALITY AGENT            │
│                                   │
│  Pass 1: Logic Review             │
│  Pass 2: Complexity Analysis      │
│  Pass 3: Test Coverage Gaps       │
│  Pass 4: Performance Flags        │
│                                   │
│  (run in parallel)                │
└───────────────────────────────────┘
        ↓
findings[]  — severity: WARN or SUGGEST
```

Logic review uses AST + heuristics. Complexity uses cyclomatic + cognitive scoring. Test coverage checks for corresponding test files. Perf pass looks for N+1s, unbounded loops, blocking I/O.

---

#### LLM Agent

Three tasks, all LLM calls. For `/review`, all three run in parallel against the same context. For focused commands (`/summarize`, `/ask`), only the relevant task runs.

```
Context slice: diff + PR data + existing comments
        ↓
┌────────────────────────────────────────┐
│             LLM AGENT                  │
│                                        │
│  Task A: Auto-Summary                  │
│    → what / why / changed / NOT changed│
│                                        │
│  Task B: Intent Questions              │
│    → 2-5 unanswered questions          │
│    → dedup against existing comments   │
│                                        │
│  (A and B run in parallel)             │
└────────────────────────────────────────┘
        ↓
metadata: { summary, questions[] }
```

For `/ask`: single LLM call with the question + full context. Returns conversational reply, not structured findings.

Each task has its own focused system prompt. Output is structured JSON, not free text.

---

#### Blast Radius Agent

Pure static analysis. No LLM calls. Traverses the repo's import graph to map everything affected by the changed files.

```
Context slice: changed file paths + full repo file list
        ↓
┌────────────────────────────────────────────┐
│           BLAST RADIUS AGENT               │
│                                            │
│  Step 1: Parse imports across entire repo  │
│    → build import graph (cached by SHA)    │
│                                            │
│  Step 2: Find direct importers             │
│    → which files import changed modules?   │
│                                            │
│  Step 3: Walk N hops outward               │
│    → who imports those files?              │
│    → stop at entry points or N=3 hops      │
│                                            │
│  Step 4: Classify findings                 │
│    → exported signatures changed? (AST)    │
│    → test files in affected set?           │
│    → env vars / config keys changed?       │
│    → migrations in diff?                   │
│    → route handlers affected?              │
└────────────────────────────────────────────┘
        ↓
blast_radius: {
  direct_importers: string[]
  transitive_importers: string[]
  interface_changed: boolean
  tests_affected: string[]
  config_changes: string[]
  migrations: boolean
  routes_affected: string[]
}
```

The result is a structured table — deterministic, cheap, no LLM needed.

**Import graph caching:** traversal is expensive on large repos. Cache the graph keyed by `(repo, commit_sha)` with a 1h TTL. On a new commit, invalidate and re-traverse. Kick off traversal in the background when a PR is opened so it is ready by the time `/review` runs.

---

#### Historical Agent

No LLM calls. Traverses git history for the changed files.

```
Context slice: changed file paths + head_sha
        ↓
┌───────────────────────────────────────────┐
│           HISTORICAL AGENT                │
│                                           │
│  1. Find commits touching changed files   │
│     (last 2 years)                        │
│                                           │
│  2. Check if those commits were followed  │
│     by a bug-fix within 7 days            │
│                                           │
│  3. Surface unresolved past review        │
│     comments on the same functions        │
│                                           │
│  4. Flag recurring vulnerability class   │
│     in the same file                      │
└───────────────────────────────────────────┘
        ↓
findings[]  — severity: WARN or SUGGEST
```

---

### Full parallel flow for `/review`

```
ReviewJob (command: "review")
        ↓
Orchestrator: route → all 5 agents
        ↓
Assemble base context (once, shared)
        ↓
┌──────────────────────────────────────────────────────┐
│  Parallel execution                                  │
│                                                      │
│  SecurityAgent ──────────────────► findings[]        │
│                                                      │
│  QualityAgent ───────────────────► findings[]        │
│                                                      │
│  LLMAgent                                            │
│    ├── Task A (summary) ─────────► metadata.summary  │
│    └── Task B (questions) ───────► metadata.questions│
│                                                      │
│  BlastRadiusAgent (static, no LLM)                   │
│    └── import graph traversal ───► blast_radius{}    │
│                                                      │
│  HistoricalAgent ────────────────► findings[]        │
│                                                      │
└──────────────────────────────────────────────────────┘
        ↓
Aggregator: merge all findings[], sort by severity
        ↓
Formatter: build comment string
  ├── HOLD findings (inline + top-level)
  ├── WARN findings (inline + top-level)
  ├── SUGGEST findings (top-level only)
  ├── Questions (top-level)
  ├── Summary (top-level)
  └── Blast radius table (top-level)
        ↓
GitHub Comment API
```

### Data tiers per command

Each command fetches only what it needs. Nothing more.

| Data | How fetched | Commands that need it |
|---|---|---|
| Diff (patch) | GitHub API `/pulls/{id}/files` | All |
| PR metadata (title, description, commits) | GitHub API `/pulls/{id}` | All |
| Full content of changed files | GitHub API `/contents/{path}` per file | All except `/summarize` |
| Dependency manifest | GitHub API `/contents/package.json` etc. | Security only |
| Full repo file list + import graph | GitHub Trees API + parse | `/blast-radius`, `/review` |
| Existing review comments | GitHub API `/pulls/{id}/comments` | `/ask`, LLM dedup |
| Previous job findings | Redis | `/re-review` only |
| Git log for changed files | GitHub API `/commits` filtered by path | Historical agent |

Import graph is the only expensive fetch. Everything else is 1-3 API calls.

### Re-review and delta mode

**Continuous commits to a PR** — a dev might push 5 commits while fixing things. Auto-running a full review on every push floods the PR.

```
Push to PR branch (synchronize event)
        ↓
Is there a prior review on this PR?
  ├── No  → do nothing (wait for explicit /review)
  └── Yes → run SecurityAgent only, silently
              ├── No new HOLD findings → post nudge:
              │   "New commits since last review. /re-review when ready."
              └── New HOLD found → post immediately, don't wait
```

On `/re-review`:

```
Load previous job findings from Redis
        ↓
Run all agents fresh against latest commit
        ↓
Diff new findings vs previous findings:
  ├── resolved: in prev, not in new
  ├── new: in new, not in prev
  └── unchanged: in both
        ↓
Post delta comment only:
"S-01 resolved. S-02 still open. 1 new SUGGEST finding."
```

Full review is not reposted. Only the delta.

---

## 3. Storage

```
┌──────────────────────────────────────────────────────┐
│                     REDIS                            │
│                                                      │
│  Job state (TTL: 4h)                                 │
│    job:{job_id}:context   → serialized ReviewJob     │
│    job:{job_id}:status    → queued|running|done|fail  │
│    job:{job_id}:findings  → AgentResult[] (for delta) │
│                                                      │
│  Installation config (persistent)                    │
│    install:{installation_id} → {                     │
│      api_key: encrypted string                       │
│      provider: anthropic|openai|gemini|bedrock       │
│      email: string                                   │
│      active_repos: string[]                          │
│    }                                                 │
│                                                      │
│  CVE cache (TTL: 6h)                                 │
│    cve:cache → OSV + GitHub Advisory snapshot        │
└──────────────────────────────────────────────────────┘
```

No code is stored persistently. Everything in the job namespace expires after 4 hours. The only persistent data is the installation config.

---

## 4. Build Phases

### Phase 1 — Agent core (no GitHub, no server)

Build and test the agents in isolation using local fixtures.

```
test-fixtures/
  pr-001/
    diff.patch
    pr.json          ← title, description, commit messages
    files/           ← full file contents
      src/config.js
      src/routes/users.js
    package.json
```

Deliverables:
- `ReviewJob` type definition
- Fixture loader: reads a fixture folder → produces a `ReviewJob`
- Security Agent (all 4 passes)
- Quality Agent (all 4 passes)
- LLM Agent (summary + intent questions)
- Blast Radius Agent (static import graph traversal)
- Historical Agent
- Orchestrator + command router
- Result aggregator + comment formatter

The output of Phase 1 is a CLI tool:
```
scrutiny review ./test-fixtures/pr-001
```
That prints the formatted review to stdout. Full agent system, zero GitHub.

### Phase 2 — Server + job queue

Wrap the agent core in a server:

- HTTP server (Fastify)
- Webhook endpoint with HMAC validation
- BullMQ job queue on Redis
- Job workers that call the orchestrator
- Redis state management

The agents from Phase 1 do not change.

### Phase 3 — GitHub integration

Add the GitHub transformer layer:

- GitHub API client (Octokit)
- Context assembler: fetches diff + files + PR data → produces `ReviewJob`
- Comment poster: takes formatted string → calls GitHub Comment API
- Installation token flow: JWT → Installation Access Token

The agents from Phase 1 still do not change. The only new code is the transformer and the poster.

### Phase 4 — Settings site + onboarding

- Small web UI for post-install callback
- API key input, provider selection, email capture
- Stores to installation config in Redis/KV
- Error email sender (API key failures, quota exceeded)

---

## 5. Posting Results to GitHub

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
      "body": "[S-01] Hardcoded API key detected (entropy 5.1)"
    },
    {
      "path": "src/routes/users.js",
      "line": 88,
      "body": "[S-02] New endpoint has no auth middleware"
    }
  ]
}
```

One API call. All inline findings posted atomically.

### Top-level comment — everything else

Summary, questions, blast radius, SUGGEST findings, PASS results:

```
POST /repos/{owner}/{repo}/issues/{pr_number}/comments

{
  "body": "## PR Scrutiny Agent — Review\n..."
}
```

PRs are issues in GitHub's model — top-level comments go to the issues endpoint.

### Full post flow

```
AgentResult[] (all agents done)
        ↓
Formatter splits findings:
  ├── inline[]  → HOLD + WARN with file + line
  └── toplevel  → summary, questions, blast radius, SUGGEST, PASS
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
{ "body": "Review in progress — results in ~30s." }
```

Store the returned `comment_id`. When results are ready, delete it and post the real comment. This gives the user immediate feedback that the agent received the command.

---

_PR Scrutiny Agent · Architecture v1.0 · June 2026_
