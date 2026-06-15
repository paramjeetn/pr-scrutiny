# PR Scrutiny Agent — Product Specification & Technical Design

**v1.0 · June 2026 · Internal Draft**

| Field | Value |
|---|---|
| Product | PR Scrutiny Agent — GitHub-native AI code reviewer |
| Type | GitHub App + Slash-command interface + Webhook integration |
| Target users | Engineering teams using GitHub for code review |
| Status | Specification — not yet implemented |
| Author | Paramjeet (AI Engineering) |

**One-line pitch:** An on-demand AI agent that lives inside GitHub as a first-class reviewer — you summon it with a slash command, it reads the full diff and repo context, posts structured review threads covering security, quality, and intent, then stays in the conversation to answer follow-ups.

---

## Table of Contents

1. [Overview & Problem Statement](#section-1-overview--problem-statement)
2. [Invocation & Trigger Model](#section-2-invocation--trigger-model)
3. [Security Checks](#section-3-security-checks)
4. [Code Quality Checks](#section-4-code-quality-checks)
5. [AI-Powered Understanding](#section-5-ai-powered-understanding)
6. [End-to-End Review Flow](#section-6-end-to-end-review-flow)
7. [Technical Architecture](#section-7-technical-architecture)
8. [Output Format & Severity Model](#section-8-output-format--severity-model)
9. [Open Questions & Future Work](#section-9-open-questions--future-work)

---

## Section 1: Overview & Problem Statement

Code review is one of the highest-leverage engineering activities. It is also chronically under-invested. Reviewers are busy, context-switching is expensive, and most review tooling is passive — it sits and waits rather than participating. Security checks happen in CI pipelines that nobody reads until they fail. Intent is rarely captured before a human reviewer even opens the diff.

PR Scrutiny Agent changes the dynamic. It is an active participant in every pull request — one that arrives immediately, reads deeply, and raises the right questions before a human reviewer ever shows up. The goal is not to replace human review. It is to make the human reviewer's time more valuable by handling the legwork and surfacing what actually matters.

### Core problems being solved

- **Security checks are asynchronous and invisible** — they run in CI but nobody reads the logs until a pipeline fails.
- **Reviewers have no context about intent** — why was this changed, what did the author consider but reject, what are the known risks?
- **Blast radius is invisible** — which other services, consumers, or contracts are affected by this diff?
- **Review quality is inconsistent** — different reviewers catch different things; there is no shared baseline.
- **Async teams waste cycles** — a PR sits for 24 hours before a reviewer even reads the description.

### Design principles

- **On-demand, not ambient** — the agent should not run on every commit like a linter. It is invoked when useful.
- **Conversational** — the agent posts to the PR thread and responds to replies. It is not a static report.
- **Structured output** — review comments are grouped by severity and category, not dumped as a wall of text.
- **Codebase-aware** — the agent reads beyond the diff to understand context: related files, history, dependents.
- **Developer-friendly** — no false positives, no style nits, no replacing the human. Signal over noise.

---

## Section 2: Invocation & Trigger Model

The agent can be triggered in three ways: explicit slash commands, automatic triggers on state transitions, and scheduled nudges for stale PRs.

### Slash commands (primary interface)

All commands are typed into the PR comment box and dispatched to the agent via GitHub webhook. The agent responds as a new top-level comment within ~30 seconds.

| Command | Description |
|---|---|
| `/review` | Full review: security pass, quality pass, blast radius, auto-summary, intent questions. |
| `/review security` | Security-only pass. Runs secrets scanner, injection surface check, dependency audit, auth gap analysis. |
| `/review deep` | Full review plus: historical pattern matching, test coverage analysis, complexity scoring on all changed functions. |
| `/review perf` | Performance-focused pass. Scans for N+1 queries, unbounded loops, large allocations, missing indexes. |
| `/ask <question>` | Direct question to the agent about the PR. E.g. `/ask why was the retry logic changed?` |
| `/summarize` | Posts a plain-English TL;DR of what this PR does. Useful before human review begins. |
| `/blast-radius` | Maps which other modules, services, tests, or API consumers are affected by this diff. |
| `/re-review` | Re-runs the last full review against the latest commit. Shows delta from the previous pass. |
| `/approve` | Requests a LGTM from the agent if all checks pass — useful for low-risk PRs with no human reviewers available. |

### Automatic triggers

The agent also activates without being called, in three situations:

- **Draft → Ready transition:** when a PR is marked ready for review, the agent runs `/summarize` and `/review security` automatically, posting the results before any human sees the PR.
- **No reviewer for 24h:** if a PR has no assigned reviewers and no review comments after 24 hours, the agent posts a `/summarize` and tags the team lead.
- **Force-push after review:** if the author force-pushes after a review has started, the agent posts a diff of what changed since the last review so reviewers do not have to re-read everything.

### Permissions and installation

The agent is a GitHub App installed at the org level. It requests:

- Read: code, pull requests, issues, checks, metadata
- Write: pull request reviews, comments, check runs
- Read: repository contents (for blast radius traversal)
- Read: Actions (for CI result correlation)

It does not require write access to code. It can never merge, push, or modify files.

---

## Section 3: Security Checks

Security is the highest-priority review category. Findings in this category always block the review with a `HOLD` annotation. The agent performs four independent passes:

### 3.1 Secrets scanner

Scans the entire diff — not just added lines — for credential patterns and high-entropy strings.

- **Regex-based detection:** API keys (AWS, GCP, GitHub, Stripe, Twilio patterns), private keys (PEM headers), JWT tokens, connection strings with embedded passwords, Bearer tokens in hardcoded strings.
- **Entropy analysis:** any string with Shannon entropy above 4.5 bits/char and length > 20 is flagged as potential secret, even without a matching pattern.
- **Encoding bypass detection:** base64-decodes all strings matching the pattern before scanning. Catches obfuscated secrets.
- **Environment variable check:** flags cases where a secret-shaped value is assigned directly to a variable rather than read from `process.env` or a secrets manager.
- **Context awareness:** ignores test fixtures, mock data directories, and `.example` files — but flags if an `.env.example` contains a real-looking value rather than a placeholder.

**False positive handling:** All entropy-flagged strings are shown with their score and the surrounding 3 lines of context, so the developer can quickly confirm or dismiss. The agent never auto-blocks on entropy alone — it posts as a `WARNING`, not a `HOLD`.

### 3.2 Injection surface analysis

Performs taint analysis on added code to detect paths from user-controlled input to dangerous sinks.

- **SQL injection:** traces request parameters through ORM calls, raw query builders, string concatenation into SQL strings. Flags missing parameterization.
- **Shell injection:** detects `os.system()`, `subprocess` calls, `exec()`, `child_process.exec()` receiving non-literal arguments.
- **SSTI (Server-Side Template Injection):** flags `template.render()` calls where the template string is constructed from user input.
- **XSS:** traces user input into `innerHTML`, `document.write()`, `dangerouslySetInnerHTML` in React, and `v-html` in Vue without sanitization.
- **Path traversal:** flags file system calls (`fs.readFile`, `open()`, `Path.join()`) receiving user-controlled input without validation.

### 3.3 Dependency audit

Checks every package added or version-bumped in the diff against the OSV (Open Source Vulnerabilities) database and the GitHub Advisory Database.

- **CVE cross-reference:** flags packages with known CVEs at CVSS 7.0+. Posts the CVE ID, score, and affected version range.
- **Yanked/deprecated packages:** flags npm unpublish events, PyPI yanked versions, and packages with no commits in 2+ years.
- **Supply chain check:** flags packages published within the last 30 days with no prior version history (new package injection risk).
- **Transitive dependencies:** for critical CVEs (CVSS 9.0+), also checks if any existing transitive dependency is affected.

### 3.4 Auth and access control gaps

Reviews routing changes, middleware stacks, and permission checks for missing or misconfigured access control.

- **New endpoints without middleware:** detects new route handlers in Express, FastAPI, Django, Rails, etc. that are not wrapped in an authentication middleware call.
- **CORS misconfiguration:** flags `Access-Control-Allow-Origin: *` added without a corresponding allowlist, or `credentials: true` combined with wildcard origin.
- **JWT verification bypass:** detects `algorithms: 'none'` in JWT decode options, missing signature verification, or accept-all alg patterns.
- **IDOR risk:** flags new endpoints that take an ID from the request and return a resource without a corresponding ownership check.
- **Rate limiting absence:** flags new public endpoints that perform expensive operations (DB writes, email sends, external API calls) without a rate limiter.

---

## Section 4: Code Quality Checks

Quality checks are informational by default. They post as `SUGGEST` annotations. The author or a human reviewer decides whether to act on them. These checks run on all changed files.

### 4.1 Logic review

The agent reads each changed function semantically and checks for correctness issues that static analysis misses.

- Off-by-one errors in loop bounds, slice indices, and pagination calculations.
- Condition inversions: flags cases where the condition and its else-branch appear to be swapped based on variable names and surrounding context.
- Unreachable branches: detects `return` statements followed by more code, always-true/false conditions given the function signature.
- Null/undefined deref: flags access on a value that has a clear nullable type or a recent null-check path that was not covered.
- Race conditions: in async code, flags shared mutable state accessed across `await` boundaries without locking.

### 4.2 Complexity analysis

| Aspect | Detail |
|---|---|
| Tool | Cyclomatic complexity per changed function |
| Thresholds | ≤10: pass. 11–20: SUGGEST refactor. >20: WARN with decomposition proposal. |
| Output | Posts the complexity score on the function signature line. If >20, proposes a specific decomposition. |
| Cognitive complexity | Also computes cognitive complexity (Sonar metric). Flags if significantly higher than cyclomatic, indicating deeply nested logic. |

### 4.3 Test coverage gaps

Identifies new code paths that are not exercised by any test in the diff or in existing test files.

- For each new function or method, checks if a corresponding test file or test case exists.
- For new branches (`if/else`, `switch` cases), checks if both branches are tested.
- Suggests specific test cases: `'This function has no test for the error path when X is null.'`
- Does not flag existing untested code — only new code added in this PR.

### 4.4 Performance regression flags

- **N+1 queries:** detects DB calls inside loops. Suggests batch loading or eager loading patterns.
- **Missing indexes:** when a new query filters by a column not in any known migration's `CREATE INDEX`, flags the potential missing index.
- **Unbounded loops:** flags `while(true)` or loops without a guaranteed termination condition.
- **Large in-memory allocations:** flags collection operations that could materialize the entire dataset (e.g. `.collect()`, `List::new()` in streaming contexts).
- **Synchronous I/O in async context:** flags blocking calls inside async handlers (`time.sleep` in asyncio, `fs.readFileSync` in Node event handlers).

---

## Section 5: AI-Powered Understanding

These features go beyond static analysis. They require the agent to read the diff in context of the full repo, ask the model to reason about the code, and produce structured output. They run as part of `/review` and `/review deep`.

### 5.1 Auto-summary

The agent reads the full diff and generates a plain-English summary structured as:

```markdown
## What this PR does
Adds rate limiting to the public API endpoints using a token bucket algorithm
stored in Redis. Applies to /v1/auth/*, /v1/users/*, and /v1/events/* routes.

## Why (inferred from diff + commit messages)
Recent spike in unauthorized scraping attempts on the events endpoint.
No issue linked but commit message references "abuse mitigation".

## What changed
- Added redis-rate-limiter middleware (new dependency)
- Applied middleware to 3 route groups in server.js
- Added RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX to .env.example
- Test suite updated for all 3 route groups

## What was NOT changed (but might need attention)
- Admin routes (/v1/admin/*) do not appear to be rate-limited
- The Redis connection is not pooled — may need review under load
```

The **"What was NOT changed"** section is the differentiator — it reflects on the scope of the change and flags things adjacent to the diff that the author may not have considered.

### 5.2 Intent clarifier

Before a human reviewer opens the PR, the agent posts targeted questions to the author. These are questions that reviewers would ask anyway — getting them answered in advance makes human review faster.

The agent generates questions by:
1. Reading the diff and identifying decisions that are not self-evident.
2. Checking the PR description and linked issues for answers already given.
3. Posting only unanswered questions — typically 2–5 per PR.

**Example questions:**
- `'Why was the exponential backoff removed from the retry handler? Was this intentional or accidental?'`
- `'This change removes the idempotency key check on payment processing. Is this safe? What guarantees idempotency now?'`
- `'The new cache TTL is hardcoded to 300 seconds. Should this be configurable per environment?'`

The agent posts as a review comment thread titled **"5 questions before review"**. Author answers inline. Human reviewer reads the answers alongside the diff. Async cycle eliminated.

### 5.3 Blast radius analysis

The agent traverses the repo to map what is affected by this diff beyond the changed files.

| Category | What is checked |
|---|---|
| Imports | Which files import the changed modules? (direct consumers) |
| API surface | Were any exported function signatures, types, or REST routes changed? (interface break risk) |
| Tests | Which test files cover the changed code? Are they in this PR? |
| Config | Were any environment variable names, config keys, or feature flags added/changed/removed? |
| DB schema | Were any migrations included? If so, is the migration reversible? |
| Dependents | Cross-repo: if this is a shared library, which other repos depend on it? (requires org-level access) |

Output is posted as a structured table. Each row is a category; the right column is the list of affected artifacts with links.

### 5.4 Historical pattern matching

The agent searches the repo's git history for similar changes and correlates them with past outcomes.

- Finds PRs in the last 2 years that touched the same files or functions.
- Checks if any of those PRs were followed by a bug-fix PR within 7 days — a signal that the pattern is risky.
- Surfaces relevant past review comments: `'In PR #312, a reviewer noted that this function has a concurrency issue. That comment was not resolved before merge.'`
- Identifies recurring security issues: if the same class of vulnerability has been fixed and re-introduced in the same file more than once, posts a `WARN` with links.

---

## Section 6: End-to-End Review Flow

```
1. PR opened / /review called
2. Diff + context fetched
3. Parallel analysis passes
4. Structured comment posted
5. Author responds
6. Re-review on push
```

### Step 1: Event received

- GitHub fires a webhook to the agent's endpoint on PR creation, comment creation (slash command), or push.
- The agent validates the webhook signature (HMAC-SHA256) and confirms the command is from a repo member.
- A job is queued. The agent posts a provisional comment: `"Review in progress — results in ~30s."`

### Step 2: Context assembly

- Fetches the full diff via GitHub API (`/pulls/{id}/files`).
- Fetches the PR description, linked issues, and commit messages.
- Fetches the full content of changed files (not just the diff) for blast radius and logic analysis.
- Fetches the repo's dependency manifest (`package.json`, `requirements.txt`, `go.mod`, etc.).
- If `/review deep`: also fetches related test files and recent git log for affected functions.

### Step 3: Analysis (parallel)

All analysis passes run in parallel. Each pass is independent and returns a structured result object:

```json
{
  "pass": "secrets_scanner",
  "severity": "HOLD",
  "findings": [
    {
      "file": "src/config.js",
      "line": 14,
      "code": "const API_KEY = \"sk-prod-abc123...\"",
      "message": "Hardcoded API key detected (entropy: 5.1). Move to environment variable.",
      "cve": null,
      "remediation": "Replace with process.env.ANTHROPIC_API_KEY"
    }
  ]
}
```

Severity levels: `HOLD | WARN | SUGGEST | PASS`

### Step 4: Structured comment posted

The agent posts a single top-level comment replacing the provisional one:

```markdown
## PR Scrutiny Agent — Review
**Commit:** a3f9c2b · 3 files changed, 142 additions, 18 deletions

---
### HOLD — Security (2 findings)
> These must be resolved before merge.
[S-01] src/config.js:14 — Hardcoded API key (entropy 5.1)
[S-02] src/routes/users.js:88 — New endpoint /v1/users/:id/export has no auth middleware

---
### WARN — Quality (1 finding)
[Q-01] src/services/dataProcessor.js — Cyclomatic complexity 24. Consider splitting processEvents().

---
### Questions for author (3)
1. Why was the batch size hardcoded to 100? Should this be configurable?
2. The old retry logic used exponential backoff. Was removing it intentional?
3. Are admin routes intentionally excluded from the new rate limiting?

---
### Summary
Adds event batching to the data processor and a new CSV export endpoint.

---
### Blast radius
Direct consumers: 4 files | Interface change: No | Migration: No | Tests in PR: Partial

_Review by PR Scrutiny Agent v1.0 · /re-review to refresh · /ask <question> to dig deeper_
```

### Step 5: Conversation continues

- The author replies to specific finding comments or to the `/ask` command.
- The agent reads the reply and responds conversationally — it can explain a finding, provide a code fix, or acknowledge a dismissal.
- If the author writes `'/ask why is S-02 a security issue?'`, the agent explains in plain English with a concrete example.
- If the author writes `'S-02 is a false positive — this route uses a session cookie checked by the global middleware'`, the agent can accept this and mark S-02 as `ACKNOWLEDGED`.

### Step 6: Re-review on push

- On every new push to the PR branch, the agent automatically re-runs all checks.
- Posts a delta comment: `'Re-review complete. S-01 resolved. S-02 still open. Q-01 answered. 1 new SUGGEST finding.'`
- Does not repost the full review — only the delta, to avoid noise.

---

## Section 7: Technical Architecture

### Components

| Component | Description |
|---|---|
| GitHub App | Registered at org level. Receives webhooks, posts comments, manages check runs. |
| Webhook receiver | Node.js/Fastify service. Validates HMAC, parses events, enqueues jobs. |
| Job queue | BullMQ on Redis. Handles parallel analysis passes with independent retry logic. |
| Analysis workers | Python workers, one per analysis type. Stateless, scalable horizontally. |
| LLM layer | Claude API (`claude-sonnet-4-6`) for logic review, auto-summary, intent questions, blast radius reasoning. |
| Static analysis | AST parsers per language (acorn for JS, `ast` module for Python, tree-sitter for others). |
| CVE database | OSV API + GitHub Advisory Database polled every 6 hours, cached in Redis. |
| Context store | Redis for job state + ephemeral PR context. No persistent storage of code. |
| GitHub API client | Octokit with exponential backoff and rate limit handling. |

### Data flow

```
GitHub Webhook
     │
     ▼
Webhook Receiver (validates HMAC, rate-limits per repo)
     │
     ▼ enqueue
Job Queue (BullMQ / Redis)
     │
     ├──► Security Worker ──► findings[]
     ├──► Quality Worker  ──► findings[]
     ├──► LLM Worker      ──► summary, questions, blast_radius
     │
     ▼ aggregate
Result Aggregator
     │
     ▼
GitHub Comment API ──► PR thread
```

### LLM prompting strategy

The LLM is used for three tasks: logic review, auto-summary, and intent question generation. Each uses a dedicated system prompt and structured output format.

- **Logic review:** the diff for each changed function is sent with the function's call sites and test coverage. The model is asked to output JSON: `{ issues: [ { line, type, description, severity } ] }`.
- **Auto-summary:** the full diff is chunked by file and summarized. Summaries are merged in a second pass that adds the "What was NOT changed" section.
- **Intent questions:** the diff plus PR description is sent. The model is asked to output 2–5 questions as JSON, each with a justification string used for de-duplication against existing PR comments.

### Privacy and security

- Code never leaves the agent's compute boundary unencrypted. TLS everywhere.
- No code is stored persistently. Context is held in Redis with a 4-hour TTL per PR job.
- LLM API calls use Anthropic's data-processing agreement. Code sent to the model is covered by the zero-data-retention option.
- The agent only accesses repositories it has been explicitly installed on.
- **Audit log:** every agent action (comment posted, review requested, finding raised) is logged with a timestamp and the triggering user/event.

---

## Section 8: Output Format & Severity Model

| Severity | Meaning |
|---|---|
| HOLD | Blocks merge. Security vulnerabilities, credential exposure, auth bypass. Requires explicit human resolution. |
| WARN | Does not block but should be addressed before merge. High complexity, missing tests for critical paths, performance issues on hot paths. |
| SUGGEST | Informational. Style, minor refactors, optional improvements. Author can dismiss with a comment. |
| PASS | Category ran and found nothing. Posted per category so the absence of findings is explicit, not ambiguous. |
| QUESTION | Intent clarification needed. Not a finding — a question for the author. Can be answered and closed. |

### Annotation placement

- `HOLD` and `WARN` findings are posted as **inline review comments** on the exact line — they appear in the diff view.
- The summary, questions, and blast radius are posted as a **single top-level PR comment**.
- `PASS` results per category are in the top-level comment only — not as inline comments.
- Re-review delta is a new top-level comment replying to the original review comment.

### What the agent does NOT do

- It does not leave style nits (spacing, naming conventions, import order). That is a linter's job.
- It does not approve PRs unless explicitly asked with `/approve`, and even then only if `HOLD` count is 0.
- It does not comment on lines it did not analyze — every inline comment has a specific finding attached.
- It does not repeat findings from a previous review if they have been marked `ACKNOWLEDGED`.
- It does not impersonate a human reviewer. Every comment is clearly attributed to PR Scrutiny Agent.

---

## Section 9: Open Questions & Future Work

### Open questions for team discussion

1. **Scope of `/approve`:** should the agent be able to satisfy a required reviewer count in GitHub branch protection rules? This requires significant trust and clear team buy-in.
2. **Cross-repo blast radius:** reading other repos requires org-level GitHub token. What is the blast radius of that permission?
3. **LLM cost model:** logic review on large PRs (500+ line diffs) is expensive. Do we limit diff size per invocation or implement chunking?
4. **False positive rate:** how do we measure and tune the secrets scanner entropy threshold without manual labelling data?
5. **Mono-repo support:** blast radius traversal in a mono-repo requires knowing the dependency graph between packages. Does the agent build this or consume an existing tool?

### Phase 2 candidates

- **IDE plugin:** expose the same `/review` command inside VS Code and Cursor, running against local diffs before a PR is even opened.
- **Learning mode:** the agent observes which of its findings humans override. Over time, per-repo tuning of thresholds.
- **Reviewer assignment:** based on blast radius, suggest which team member is best positioned to review this PR.
- **Test generation:** for functions flagged as missing test coverage, generate a test stub and commit it to the PR branch.
- **Changelog generation:** after merge, auto-generate a CHANGELOG entry from the auto-summary.

---

_PR Scrutiny Agent · Product Spec v1.0 · June 2026_
