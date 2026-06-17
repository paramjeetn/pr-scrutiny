# Architecture Decisions

Decisions made during design, with reasoning. Ordered chronologically.

---

## 1. GitHub App over GitHub Action

**Decision:** Build as a GitHub App, not a GitHub Action.

**Reason:** GitHub Actions run inside the repo's CI pipeline — we would need to be installed per-repo and would have no way to receive slash commands from PR comments or manage installation state centrally. A GitHub App gives us a webhook endpoint, org-level installation, and the ability to receive any PR event across all repos in one place.

---

## 2. Agent is text-only output

**Decision:** The agent only posts comments. It never merges, approves, or modifies files.

**Reason:** Keeping the agent read+comment-only removes a whole class of trust and safety concerns. If a reviewer wants to merge, they do it themselves. The agent's job is to inform, not to act.

---

## 3. BYOK (Bring Your Own Key)

**Decision:** Customers provide their own LLM API key. We never pay for tokens.

**Reason:** Billing is handled directly between the customer and their model provider. We store the key encrypted per installation. This also lets customers choose their provider (Anthropic, OpenAI, Google) and control their own data agreement with that provider.

---

## 4. Cloud Run over Cloudflare Workers

**Decision:** Google Cloud Run over Cloudflare Workers.

**Reason:** CF Workers have a 30s CPU time limit. Our static analysis agents (regex, entropy, import graph parsing) can exceed that on large diffs. Cloud Run gives full Node.js with no CPU limit, container-based local dev (`docker run` or `tsx watch`), and native GCP ecosystem (Firestore, Secret Manager, KMS). Cold start (~1-2s) is irrelevant — webhook processing takes 15-30s anyway. Concurrency set to 1 per instance isolates jobs from each other.

**What we lose:** Sub-millisecond cold starts, free tier. Acceptable tradeoffs for a resume project where correctness and robustness matter more than edge latency.

---

## 5. Vercel AI SDK over Google ADK

**Decision:** Use Vercel AI SDK for LLM calls, not Google ADK.

**Reason:** Vercel AI SDK is provider-agnostic (Anthropic/OpenAI/Google all supported natively — critical for BYOK), has structured output via `generateObject()` with Zod schemas, and is just a library — no framework opinions about agent orchestration. We wire the multi-agent orchestration ourselves, which gives us full control over which agents run, timeouts, and partial results. Google ADK would lock us to their orchestration model and Gemini-first design.

---

## 6. Blast radius is pure static analysis — no LLM

**Decision:** BlastRadiusAgent uses import graph traversal only. No LLM calls.

**Reason:** Everything blast radius needs is deterministic: which files import the changed modules, which exports changed, which tests cover the changed code, which routes are affected. An LLM adds cost, latency, and non-determinism for zero benefit here. The import graph is built from regex-based import parsing — cheap and accurate for the common cases (JS/TS import/require, Python import, Go import).

---

## 7. Cross-file analysis via related_files (1-hop)

**Decision:** `ReviewJob` includes `related_files` — the imports of changed files fetched one hop out.

**Reason:** Some passes (injection surface, auth gaps) require cross-file context. A taint source might be in `routes/users.js` and the sink in `utils/db.js`. An auth middleware might live in a file that was not changed. Fetching 1-hop imports gives cross-file passes enough context without pulling the entire repo.

**Assembly algorithm:** Parse import/require statements from changed files (regex-based), resolve relative paths, deduplicate, fetch up to 10 most-referenced files via GitHub Contents API.

---

## 8. Continuous commits — silent security scan, explicit re-review

**Decision:** On every push to a PR branch, run the security agent silently. Post only if a new HOLD is found. Otherwise post a nudge comment. Full re-review only on explicit `/re-review`.

**Reason:** A developer might push 5 commits while fixing things. Auto-running a full review on every push floods the PR with noise. The silent security scan catches new secrets or critical issues immediately. Everything else waits for the developer to signal they are ready with `/re-review`.

---

## 9. Two GitHub API calls to post a full review

**Decision:** Batch all inline comments into one review object. Post top-level comment separately. Two calls total regardless of finding count.

**Reason:** GitHub's `/pulls/{id}/reviews` endpoint accepts an array of inline comments in a single request — one atomic review, multiple line annotations. The top-level summary goes to `/issues/{id}/comments`. This is the most efficient posting model and avoids rate limit issues from many individual comment calls.

---

## 10. Firestore over Redis / KV

**Decision:** Use Google Firestore for installation config, job state, and idempotency.

**Reason:** Firestore is serverless, strongly consistent (unlike CF KV which is eventually consistent with 60s propagation), supports TTL policies per-document, and is native to GCP — no external infrastructure to manage. Three collections cover all our needs: `installations/` (persistent), `jobs/` (4h TTL), `idempotency/` (24h TTL).

---

## 11. Command router — one sequence per command

**Decision:** Each slash command maps to a fixed set of agents. The orchestrator is a command router, not a dynamic planner.

**Reason:** Dynamic planning (letting an LLM decide which agents to run) adds latency, cost, and unpredictability. Our command set is small and well-defined. A static router is fast, testable, and predictable. Each command's agent set is explicit and auditable.

| Command | Agents |
|---|---|
| `/review` | Security, Quality, LLM, BlastRadius |
| `/review security` | Security |
| `/review perf` | Quality (perf mode) |
| `/summarize` | LLM (summary task) |
| `/ask` | LLM (conversational) |
| `/blast-radius` | BlastRadius |
| `/re-review` | All + delta mode |

---

## 12. v1 static analysis is pattern-based, not AST

**Decision:** Security and Quality agents use regex + string heuristics in v1. No AST parsing.

**Reason:** Building a cross-language taint tracker is a multi-month effort. For a resume project, pattern-based detection is honest and sufficient — it catches hardcoded secrets, direct `eval(userInput)`, missing auth middleware, N+1 loops, and high-complexity functions. These are the findings that matter most in real reviews. AST-level data flow tracking (using babel/acorn for JS/TS) is a v2 goal, clearly scoped in the architecture doc.

**What this means concretely:**
- Injection pass: grep for dangerous sinks (`exec`, `eval`, raw SQL builders) and check if the argument looks like a variable (not a literal). Cross-file: grep `related_files` for the variable's origin.
- Auth pass: find new route handlers in diff, grep for auth middleware import/usage in the same file or related files.
- Complexity pass: count branching keywords per function block, not true cyclomatic complexity from a CFG.

This is the same approach tools like Semgrep use for pattern rules — proven to be effective for the common cases.

---

## 13. Agent timeouts with partial results

**Decision:** Each agent has a timeout (30s static, 60s LLM). If an agent times out, post results from the agents that did complete.

**Reason:** LLM providers have outages. Network calls fail. A full review with 3/4 agents is better than no review. The orchestrator uses `Promise.allSettled` and includes a note in the comment for any timed-out agent: "Summary unavailable — LLM provider timeout."

---

## 14. Diff size limits and token budget

**Decision:** Hard caps on context size before agents run. Max 25 files, 500 diff lines, 12k tokens per LLM call.

**Reason:** Without limits, a 50-file refactor PR would blow up LLM costs and exceed context windows. The Context Assembler enforces limits by prioritizing security-sensitive paths (`routes/`, `auth/`, `config/`) and high-change-volume files. Skipped files are listed in the summary. Static agents have no token budget — regex scales linearly and CPU is not a concern on Cloud Run.

---

## 15. Webhook idempotency via delivery header

**Decision:** Use GitHub's `X-GitHub-Delivery` header as the idempotency key. Store in Firestore with 24h TTL.

**Reason:** GitHub webhook delivery is at-least-once. The same event can arrive 2-3 times. Without dedup, we'd post duplicate reviews. The delivery header is unique per webhook attempt and is the standard way to handle this. Additionally, we check `(repo, pr_number, head_sha)` to prevent duplicate jobs from rapid `/review` commands.

---

## 16. Historical Agent deferred to post-Phase 3

**Decision:** Historical Agent (git log correlation, recurring bug patterns) is not in Phase 1. Deferred to after GitHub API integration.

**Reason:** The Historical Agent needs `GET /commits?path=X` per changed file — N API calls that only make sense when the GitHub API client is wired (Phase 3). In Phase 1 (local fixtures), there's no real git history to traverse. Faking it with JSON fixtures would test the correlation logic but not the data acquisition, which is the hard part. Build it when the data source exists.

---

## 17. Observability via JobTrace

**Decision:** Every job produces a structured `JobTrace` with per-agent timing, finding counts, and LLM token usage. Logged to Cloud Logging and shown in the GitHub comment.

**Reason:** For a resume project, being able to demo with real numbers matters. "Security: 420ms, 3 findings. LLM: 12.4s, summary + 3 questions." Also critical for debugging — when something is slow or broken, the trace tells you which agent and why. Stored in Firestore with 7-day TTL for post-mortem analysis.

---

## 18. Repo config via .pr-scrutiny.yml

**Decision:** Repos can include an optional `.pr-scrutiny.yml` to customize behavior (ignore paths, minimum severity, disable agents).

**Reason:** One-size-fits-all doesn't work. A monorepo might want to disable blast radius (too large). A team might only want HOLD/WARN findings, not SUGGEST. A project with generated code needs to ignore `dist/` and `*.generated.ts`. The config file is fetched by the Context Assembler before building the ReviewJob. If absent, defaults apply. Invalid YAML is silently ignored.
