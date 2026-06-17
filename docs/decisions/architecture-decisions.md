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

## 4. Event-driven, not long-running

**Decision:** Cloudflare Workers (V8 isolates) over a persistent server.

**Reason:** Each PR invocation gets its own isolated Worker instance. No job queue needed. No repo X blocking repo Y. Sub-millisecond cold starts since packages are bundled at deploy time via wrangler, not installed at runtime. Free tier covers 100k requests/day.

---

## 5. Vercel AI SDK over Google ADK

**Decision:** Use Vercel AI SDK for the agent framework, not Google ADK (Python or TS).

**Reason:** Google ADK TS requires Node.js 18+ and uses Node-specific APIs that are unavailable in Cloudflare Workers V8 isolates. Vercel AI SDK is edge-compatible, provider-agnostic (Anthropic/OpenAI/Google all supported natively — critical for BYOK), and is just a library that bundles cleanly into a Worker. We wire the multi-agent orchestration ourselves which gives us full control over which agents run per command.

---

## 6. Blast radius is pure static analysis — no LLM

**Decision:** BlastRadiusAgent uses import graph traversal only. No LLM calls.

**Reason:** Everything blast radius needs to detect is deterministic: which files import the changed modules, which exports changed, which tests cover the changed code, which routes are affected. An LLM is not needed for graph traversal. This keeps blast radius fast, cheap, and 100% accurate. The import graph is cached by `(repo, commit_sha)` to avoid re-traversal on repeated calls.

---

## 7. Cross-file analysis via related_files (1-hop)

**Decision:** `ReviewJob` includes `related_files` — the imports of changed files fetched one hop out.

**Reason:** Some passes (injection taint, auth gaps) require cross-file context. A taint source might be in `routes/users.js` and the sink in `utils/db.js`. An auth middleware might live in a file that was not changed. Fetching 1-hop imports gives cross-file passes enough context without pulling the entire repo. The diff is always multiple files (`FileDiff[]`).

---

## 8. Continuous commits — silent security scan, explicit re-review

**Decision:** On every push to a PR branch, run the security agent silently. Post only if a new HOLD is found. Otherwise post a nudge comment. Full re-review only on explicit `/re-review`.

**Reason:** A developer might push 5 commits while fixing things. Auto-running a full review on every push floods the PR with noise. The silent security scan catches new secrets or critical issues immediately. Everything else waits for the developer to signal they are ready with `/re-review`.

---

## 9. Two GitHub API calls to post a full review

**Decision:** Batch all inline comments into one review object. Post top-level comment separately. Two calls total regardless of finding count.

**Reason:** GitHub's `/pulls/{id}/reviews` endpoint accepts an array of inline comments in a single request — one atomic review, multiple line annotations. The top-level summary goes to `/issues/{id}/comments`. This is the most efficient posting model and avoids rate limit issues from many individual comment calls.

---

## 10. Cloudflare KV over Redis

**Decision:** Use Cloudflare KV for installation config and job state instead of Redis.

**Reason:** Staying entirely within the Cloudflare ecosystem removes the need for an external Redis instance. KV handles both use cases: installation config (persistent, keyed by installation_id) and job state for re-review delta (TTL 4h). No additional infrastructure to manage.

---

## 11. Command router — one sequence per command

**Decision:** Each slash command maps to a fixed set of agents. The orchestrator is a command router, not a dynamic planner.

**Reason:** Dynamic planning (letting an LLM decide which agents to run) adds latency, cost, and unpredictability. Our command set is small and well-defined. A static router is fast, testable, and predictable. Each command's agent set is explicit and auditable.

| Command | Agents |
|---|---|
| `/review` | Security, Quality, LLM, BlastRadius, Historical |
| `/review security` | Security |
| `/review perf` | Quality (perf mode) |
| `/summarize` | LLM (summary task) |
| `/ask` | LLM (conversational) |
| `/blast-radius` | BlastRadius |
| `/re-review` | All + delta mode |
