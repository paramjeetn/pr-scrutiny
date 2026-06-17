# PR Scrutiny Agent — Spec

**v1.0 · June 2026**

An on-demand AI agent that lives inside GitHub as a first-class reviewer. Summon it with a slash command, it reads the full diff and repo context, posts structured review threads covering security, quality, and intent, then stays in the conversation to answer follow-ups.

---

## 1. How It Works

### GitHub interaction

Two directions:

- **Inbound:** GitHub sends a webhook POST to our endpoint on every relevant event (PR opened, comment created, push). That is how the system wakes up.
- **Outbound:** We call the GitHub REST API with an Installation Access Token to read diffs, fetch files, and post review comments.

Token flow: we sign a JWT with the App's private key → exchange it for a short-lived token scoped to that installation → use it for all API calls in that job.

### Wakeup model

Event-driven, not long-running. GitHub fires webhook → our endpoint receives it → job queued → process runs → done.

Start with a long-running server (Fly.io / Railway / Render). Migrate to serverless (Lambda / Cloudflare Workers) if cost or scale demands it.

Possible runtimes: Cloudflare Workers, AWS Lambda, Fly.io, Railway, Render, self-hosted Docker.

### How users provide their API key

1. User installs the GitHub App.
2. They are redirected to a small settings page we host.
3. They paste their API key (Anthropic, OpenAI, Gemini, or AWS Bedrock credentials).
4. We store it encrypted, keyed to their Installation ID.
5. Every job for that installation uses their key. We never pay for tokens.

Alternative for self-hosted: `.pr-scrutiny.yml` in the repo pointing to an env var.

### Multi-user / multi-repo / multi-PR

GitHub handles routing out of the box. Every webhook payload contains:

```json
{
  "installation": { "id": 12345 },
  "repository": { "full_name": "acme/repo-a" },
  "pull_request": { "number": 42 }
}
```

We use `(installation_id, repo, pr_number)` as the job key. Each job is fully isolated.

**GitHub manages:** who installed the app, which repos it covers, token scoping per installation.

**We manage:** job isolation, API key lookup per installation, review logic, context assembly.

### Installation model

```
Org installs GitHub App
    ↓
GitHub creates Installation ID
    ↓
Customer adds their API key in settings
    ↓
All repos in the org become active
```

One installation covers the entire org. Individual repos can be excluded in settings.

### Permission model

The installation belongs to the org, not the installer. All collaborators with PR access can use the agent.

| Role | Allowed |
|---|---|
| Any collaborator with PR access | `/review`, `/ask`, `/summarize`, `/blast-radius` |
| Repo admin | API key config, billing, app settings |

---

## 2. Slash Commands

Typed into the PR comment box. Agent responds as a new comment within ~30 seconds.

| Command | What it does |
|---|---|
| `/review` | Full review: security, quality, blast radius, summary, intent questions |
| `/review security` | Security-only: secrets, injection, dependencies, auth gaps |
| `/review perf` | Performance pass: N+1 queries, unbounded loops, large allocations, missing indexes |
| `/ask <question>` | Direct question about the PR |
| `/summarize` | Plain-English TL;DR of what this PR does |
| `/blast-radius` | Maps which modules, services, tests, and consumers are affected |
| `/re-review` | Re-runs last full review on latest commit, shows delta only |

### Automatic triggers

- **Draft → Ready:** agent runs `/summarize` + `/review security` before any human sees the PR.
- **No reviewer for 24h:** agent posts `/summarize` and tags the team lead.
- **Force-push after review:** agent posts a diff of what changed since the last review.

---

## 3. GitHub App Permissions

Installed at the org level. Requested permissions:

- Read: code, pull requests, issues, checks, metadata, repository contents, Actions
- Write: pull request reviews, comments, check runs

The agent cannot merge, push, or modify files. Ever.

---

## 4. What the Agent Reviews

### Security (severity: HOLD — blocks merge)

**Secrets scanner**
- Regex patterns: AWS/GCP/GitHub/Stripe/Twilio API keys, PEM headers, JWTs, connection strings, Bearer tokens.
- Entropy analysis: strings with Shannon entropy > 4.5 bits/char and length > 20 flagged as potential secrets.
- Encoding bypass: base64-decodes candidate strings before scanning.
- Ignores test fixtures, mock dirs, `.example` files — but flags `.env.example` with real-looking values.
- Entropy flags post as WARN, not HOLD. Developer confirms or dismisses with 3 lines of context shown.

**Injection surface**
- SQL injection: traces request params through ORM calls, raw query builders, string concatenation.
- Shell injection: `os.system()`, `subprocess`, `exec()`, `child_process.exec()` with non-literal args.
- SSTI: `template.render()` with user-controlled template string.
- XSS: user input into `innerHTML`, `document.write()`, `dangerouslySetInnerHTML`, `v-html`.
- Path traversal: `fs.readFile`, `open()`, `Path.join()` with user-controlled input.

**Dependency audit**
- CVEs at CVSS 7.0+ flagged with CVE ID, score, and affected version range. Source: OSV + GitHub Advisory DB.
- Yanked/deprecated packages and packages with no commits in 2+ years.
- Packages published in the last 30 days with no prior version history (supply chain risk).
- For CVSS 9.0+: also checks transitive dependencies.

**Auth and access control**
- New route handlers not wrapped in auth middleware.
- `Access-Control-Allow-Origin: *` without allowlist, or `credentials: true` with wildcard origin.
- `algorithms: 'none'` in JWT decode, missing signature verification.
- New endpoints returning a resource by ID without an ownership check (IDOR).
- New public endpoints doing expensive operations without a rate limiter.

### Code quality (severity: SUGGEST — informational)

**Logic review**
- Off-by-one errors in loops, slices, pagination.
- Condition inversions based on variable names and surrounding context.
- Unreachable branches, always-true/false conditions.
- Null/undefined deref on nullable types.
- Shared mutable state across `await` boundaries in async code.

**Complexity**
- Cyclomatic complexity per changed function. Thresholds: ≤10 pass, 11–20 suggest refactor, >20 warn with decomposition proposal.
- Cognitive complexity (Sonar metric) flagged if significantly higher than cyclomatic.

**Test coverage**
- New functions with no corresponding test case.
- New branches (`if/else`, `switch`) with only one side tested.
- Suggests specific missing cases: `'No test for error path when X is null.'`
- Does not flag existing untested code — only new code in this PR.

**Performance**
- DB calls inside loops (N+1). Suggests batch/eager loading.
- New queries filtering by unindexed columns.
- `while(true)` or loops without guaranteed termination.
- `.collect()` or equivalent materializing an entire dataset in a streaming context.
- Blocking I/O inside async handlers (`time.sleep` in asyncio, `fs.readFileSync` in Node).

### AI-powered features (runs with `/review`)

**Auto-summary** — structured plain-English summary:
- What this PR does
- Why (inferred from diff + commit messages)
- What changed
- What was NOT changed (but might need attention) ← the differentiator

**Intent clarifier** — 2–5 targeted questions posted before any human reviews. Only questions not already answered in the PR description. Author answers inline; human reviewer reads the thread.

**Blast radius** — traverses the repo to map what is affected:

| Category | What is checked |
|---|---|
| Imports | Files that import changed modules |
| API surface | Exported signatures, types, or REST routes changed |
| Tests | Test files covering changed code — are they in this PR? |
| Config | Env vars, config keys, feature flags added/changed/removed |
| DB schema | Migrations included? Reversible? |
| Dependents | Cross-repo: other repos depending on this library (requires org token) |

**Historical pattern matching** — searches git history for similar changes, correlates with bug-fix PRs within 7 days, surfaces past review comments on the same functions, flags recurring vulnerability patterns.

---

## 5. Review Output Format

### Severity levels

| Level | Meaning |
|---|---|
| HOLD | Blocks merge. Security vulnerabilities, credential exposure, auth bypass. Requires explicit human resolution. |
| WARN | Should be addressed before merge. High complexity, missing critical tests, hot-path performance issues. |
| SUGGEST | Informational. Author can dismiss with a comment. |
| PASS | Category ran clean. Explicit so absence of findings is never ambiguous. |
| QUESTION | Intent clarification for the author. Closeable once answered. |

### Comment structure

```
## PR Scrutiny Agent — Review
Commit: a3f9c2b · 3 files changed, 142 additions, 18 deletions

---
HOLD — Security (2 findings)
> These must be resolved before merge.
[S-01] src/config.js:14 — Hardcoded API key (entropy 5.1)
[S-02] src/routes/users.js:88 — New endpoint has no auth middleware

---
WARN — Quality (1 finding)
[Q-01] src/services/dataProcessor.js — Cyclomatic complexity 24

---
Questions for author (3)
1. Why was the batch size hardcoded to 100?
2. Was removing exponential backoff intentional?
3. Are admin routes excluded from rate limiting on purpose?

---
Summary
Adds event batching and a new CSV export endpoint.

---
Blast radius
Direct consumers: 4 files | Interface change: No | Migration: No | Tests in PR: Partial

/re-review to refresh · /ask <question> to dig deeper
```

### Placement rules

- `HOLD` and `WARN`: inline comments on the exact diff line.
- Summary, questions, blast radius: single top-level PR comment.
- `PASS` per category: top-level comment only.
- Re-review delta: new top-level comment, not a full re-post.

### What the agent does NOT do

- No style nits. That is a linter's job.
- No inline comments without a specific finding attached.
- No repeating findings already marked ACKNOWLEDGED.
- No impersonating a human reviewer.

---

## 6. System Architecture

### Data flow

```
GitHub Webhook
     │
     ▼
Webhook Receiver
(validate HMAC-SHA256, confirm caller is repo member, rate-limit per repo)
     │
     ▼ enqueue job (installation_id, repo, pr_number)
Job Queue (BullMQ / Redis)
     │
     ├──► Security Worker   ──► findings[]
     ├──► Quality Worker    ──► findings[]
     ├──► LLM Worker        ──► summary, questions, blast_radius
     │         └── uses customer API key from installation config
     ▼ aggregate
Result Aggregator
     │
     ▼
GitHub Comment API ──► PR thread
```

### Context assembled per job

```
System Prompt
+
PR diff + full changed file contents
+
PR description, linked issues, commit messages
+
Existing review comments
+
Dependency manifest (package.json / requirements.txt / go.mod)
+
related test files + git log for affected functions (on `/review` invocation)
```

### LLM output formats

- **Logic review:** `{ issues: [ { line, type, description, severity } ] }`
- **Auto-summary:** streamed markdown, merged in a second pass for "What was NOT changed"
- **Intent questions:** `[ { question, justification } ]` — justification used to de-duplicate against existing PR comments

### Storage

- Redis: job state + ephemeral PR context, 4-hour TTL per job.
- No persistent code storage.
- Installation config (encrypted API keys, settings): simple KV store keyed by Installation ID.

### Privacy

- TLS everywhere. Code never leaves the agent's compute boundary unencrypted.
- Under BYOK, code is sent to the customer's provider under the customer's own data agreement.
- Audit log: every agent action logged with timestamp and triggering user/event.
- Agent only accesses repos it has been explicitly installed on.

---

## 7. Open Questions

1. **Cross-repo blast radius:** requires org-level token. What is the permission blast radius of that?
3. **LLM cost on large diffs:** 500+ line diffs are expensive. Limit diff size or implement chunking?
4. **Secrets scanner tuning:** how to measure and tune the entropy threshold without labelled data?
5. **Mono-repo support:** blast radius traversal needs the internal dependency graph. Build it or consume an existing tool?

### Phase 2

- IDE plugin: `/review` against local diffs before a PR is opened.
- Learning mode: per-repo threshold tuning based on which findings humans override.
- Reviewer assignment: suggest best reviewer based on blast radius.
- Test generation: generate test stubs for flagged uncovered functions, commit to PR branch.
- Changelog generation: auto-generate CHANGELOG entry from the auto-summary after merge.

---

_PR Scrutiny Agent · Spec v1.0 · June 2026_
