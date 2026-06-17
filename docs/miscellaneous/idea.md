# PR Scrutiny — Project Plan

## What Is This?

**PR Scrutiny** is a multi-agent code review pipeline that takes a GitHub PR URL and produces a deep, structured review across Security, Logic, and Maintainability dimensions — automatically. No human writes the review. The agent fetches the PR, understands context, runs parallel specialist analysis, and posts a formatted comment back to GitHub.

The thesis: depth over speed. Where tools like PR-Agent optimize for a single LLM call (~30 seconds), PR Scrutiny runs parallel specialist agents that each focus exclusively on one dimension — producing reviews that go deeper on high-stakes PRs at the cost of additional LLM calls.

Built on **Google ADK** with **Gemini 2.5 Flash**, GitHub REST API for tool use, and Pydantic for structured outputs at every stage.

---

## Core Design Principle

**No validation loops. Every agent is a transformation, not a judge.**

This is the lesson from the eval harness generator — verifier/refiner loops get stuck in prompt optimization hell. Every stage here takes input and produces structured output. The next stage reads that output as data, not as something to score.

---

## Architecture Overview

```
Input: GitHub PR URL
        │
        ▼
┌─────────────────────┐
│   FetchAgent        │  Pure tool call — no LLM
│   GitHub REST API   │  Pulls diff, files, PR metadata
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│   ContextAgent      │  1 LLM call → Pydantic output
│   PR Summarizer     │  What changed, what kind of change, which functions
└─────────┬───────────┘
          │
          ▼
┌─────────────────────────────────────────────────┐
│              ParallelAgent                       │
│  ┌─────────────┐ ┌─────────────┐ ┌───────────┐ │
│  │ SecurityAgent│ │  LogicAgent │ │StyleAgent │ │
│  │             │ │             │ │           │ │
│  └─────────────┘ └─────────────┘ └───────────┘ │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
           ┌─────────────────────┐
           │   SynthesisAgent    │  Merges all 3 outputs
           │                     │  Assigns severity levels
           └─────────┬───────────┘
                     │
                     ▼
           ┌─────────────────────┐
           │   OutputAgent       │  Posts to GitHub PR
           │                     │  or returns JSON
           └─────────────────────┘
```

---

## Agent Breakdown

### FetchAgent (Custom BaseAgent — no LLM)

Pure tool use. Calls GitHub REST API to pull:
- PR title, description, author, base branch
- Full unified diff (`/pulls/{pr}/files`)
- List of changed files with patch content
- PR comments (for context if re-running)

Stores to session state:
```python
{
  "pr_metadata": { title, description, author, base_branch },
  "changed_files": [ { filename, status, additions, deletions, patch } ],
  "raw_diff": "...",
}
```

No LLM call here. This keeps it deterministic and fast.

---

### ContextAgent (LlmAgent)

**Input:** `pr_metadata` + `changed_files` from session state

**Task:** Understand what this PR is actually doing before any specialist looks at it.

**Pydantic output schema:**
```python
class PRContext(BaseModel):
    change_type: Literal["feature", "bugfix", "refactor", "config", "test", "mixed"]
    summary: str                        # 2-3 sentence plain English summary
    modified_functions: list[str]       # function/method names touched
    entry_points: list[str]             # files most central to the change
    complexity_signal: Literal["low", "medium", "high"]  # rough signal for specialists
    language: str                       # primary language detected
```

This context object gets passed to all three specialist agents. They don't re-read the raw diff from scratch — they read the structured context + the diff together.

---

### Specialist Agents (ParallelAgent — all 3 run simultaneously)

All three receive the same inputs: `raw_diff` + `pr_context`

Each produces a `ReviewSection` Pydantic object:

```python
class ReviewItem(BaseModel):
    file: str
    line_reference: str           # e.g. "line 42" or "lines 38-51"
    issue: str                    # plain English description
    severity: Literal["critical", "warning", "suggestion", "nitpick"]
    recommendation: str           # what to do about it

class ReviewSection(BaseModel):
    dimension: str
    items: list[ReviewItem]
    overall_signal: Literal["clean", "minor_issues", "needs_attention", "blocking"]
```

#### SecurityAgent
Looks for:
- Hardcoded secrets, API keys, tokens
- SQL/command injection patterns
- Insecure deserialization
- Missing auth/authz checks
- Unsafe use of `eval`, `exec`, `subprocess`
- Exposed sensitive data in logs or responses

Prompt anchored to: "You are a security-focused code reviewer. Do not comment on style or logic. Only report security concerns with file and line references."

#### LogicAgent
Looks for:
- Null/None dereferences
- Off-by-one errors in loops/slices
- Unhandled exceptions or bare `except`
- Race conditions or shared state issues
- Missing edge case handling (empty list, zero, negative)
- Incorrect condition logic (flipped operators, wrong boolean)

Prompt anchored to: "You are a logic-focused code reviewer. Do not comment on style or security. Only report correctness and edge case concerns."

#### StyleAgent
Looks for:
- Functions >30 lines doing multiple things
- Unclear variable/function naming
- Dead code or commented-out blocks
- Missing or misleading docstrings on public functions
- Duplicated logic that could be extracted
- Overly complex conditionals that reduce readability

Prompt anchored to: "You are a maintainability-focused code reviewer. Do not comment on security or logic correctness. Only report style, readability, and maintainability concerns."

---

### SynthesisAgent (LlmAgent)

**Input:** All three `ReviewSection` objects + `pr_context`

**Task:** Merge into a single coherent review. Deduplicate overlapping findings. Order by severity. Write a top-level summary.

**Pydantic output schema:**
```python
class FinalReview(BaseModel):
    pr_summary: str                     # what the PR does in 1-2 sentences
    overall_verdict: Literal["approve", "request_changes", "comment"]
    blocking_issues: list[ReviewItem]   # critical severity only
    warnings: list[ReviewItem]          # warning severity
    suggestions: list[ReviewItem]       # suggestion + nitpick
    security_signal: str                # one sentence on security posture
    logic_signal: str                   # one sentence on correctness posture
    style_signal: str                   # one sentence on maintainability
```

This agent does NOT re-analyze the diff. It only reads the structured outputs from the three specialists and synthesizes them. This keeps it from second-guessing the specialists.

---

### OutputAgent (Custom BaseAgent — no LLM)

Formats `FinalReview` into a GitHub-flavored markdown comment and posts it via GitHub API (`POST /repos/{owner}/{repo}/issues/{pr_number}/comments`).

Output format:

```markdown
## 🤖 Automated Code Review

**PR:** Add user authentication middleware
**Verdict:** ⚠️ Request Changes

### Summary
This PR adds JWT-based authentication middleware to the Express router...

---

### 🚨 Blocking Issues
| File | Lines | Issue | Recommendation |
|------|-------|-------|----------------|
| `auth/middleware.js` | 42 | JWT secret hardcoded as string literal | Move to environment variable |

### ⚠️ Warnings
...

### 💡 Suggestions
...

---
*Security: Minor concerns found. Logic: Clean. Maintainability: Some complexity in auth handler.*
```

---

## Session State Flow

| Key | Set By | Read By |
|-----|---------|---------|
| `pr_metadata` | FetchAgent | ContextAgent |
| `changed_files` | FetchAgent | ContextAgent, all specialists |
| `raw_diff` | FetchAgent | all specialists |
| `pr_context` | ContextAgent | all specialists, SynthesisAgent |
| `security_review` | SecurityAgent | SynthesisAgent |
| `logic_review` | LogicAgent | SynthesisAgent |
| `style_review` | StyleAgent | SynthesisAgent |
| `final_review` | SynthesisAgent | OutputAgent |

---

## Tech Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Agent framework | Google ADK | You already know it deeply |
| LLM | Gemini 2.5 Flash | Native ADK support, fast, cheap |
| Structured outputs | Pydantic schemas on LlmAgent | Same pattern as harness generator |
| GitHub integration | PyGithub or raw REST | Simple, well-documented |
| Config | config.yaml + .env | Same pattern as harness generator |
| Output | GitHub PR comment + JSON file | Real, demonstrable output |

---

## What You Are NOT Building

Deliberately excluded to avoid complexity traps:

- ❌ No code execution or sandboxing (Vertex AI code runner)
- ❌ No iterative refinement loops between agents
- ❌ No "judge" agent that scores the review quality
- ❌ No frontend UI (ADK web UI is enough for demo)
- ❌ No vector DB or RAG over the codebase (out of scope)
- ❌ No CI/CD integration (GitHub Actions webhook is a stretch goal)

---

## Stretch Goals (only after core works)

- **GitHub Actions trigger** — run the agent automatically on PR open via webhook
- **Codebase context** — fetch the full file (not just the diff) for functions that were modified, giving specialists more context
- **Language-specific rules** — pass language (from ContextAgent) to specialists so they apply Python/JS/Go-specific patterns
- **Diff size gating** — if PR has >500 lines changed, warn and only review the top 5 files by change volume

---

## File Structure

```
pr-scrutiny/
├── src/
│   ├── orchestrator/
│   │   └── agent.py              # All agent definitions
│   └── shared/
│       ├── config.yaml
│       ├── config.py
│       ├── github_tools.py       # GitHub API wrapper functions
│       ├── schemas.py            # All Pydantic models
│       └── agent_prompts.py      # Prompt templates per agent
├── outputs/
│   └── review_YYYY-MM-DD_HH-MM-SS/
│       ├── pr_context.json
│       ├── security_review.json
│       ├── logic_review.json
│       ├── style_review.json
│       └── final_review.json
├── .env                          # GITHUB_TOKEN, GOOGLE_API_KEY
├── Makefile
└── README.md
```

---

## Build Order

Build and test each stage before moving to the next. Do not wire the full pipeline until each agent works in isolation.

**Day 1**
- Set up project structure, config, `.env`
- Build `github_tools.py` — test PR fetch independently with a real PR
- Define all Pydantic schemas in `schemas.py`
- Write all prompt templates in `agent_prompts.py`

**Day 2**
- Build and test `FetchAgent` + `ContextAgent` end-to-end
- Verify `PRContext` output looks correct on 2-3 real PRs
- Tune `ContextAgent` prompt until `change_type` and `modified_functions` are reliable

**Day 3**
- Build all three specialist agents
- Test each independently (pass fake `pr_context` + a real diff)
- Verify `ReviewSection` output is structured correctly
- Wire into `ParallelAgent`

**Day 4**
- Build `SynthesisAgent`
- Test with real specialist outputs
- Build `OutputAgent` — format markdown, post to a test repo PR
- Wire full pipeline end-to-end

**Day 5**
- Run on 5 real PRs (use your own repos or open source ones)
- Fix any prompt issues that surface
- Write README with architecture diagram and example output
- Record a short demo (screen record: paste PR URL → review appears on GitHub)

---

## Resume Bullet Sketch (after building)

- Built PR Scrutiny — a multi-agent PR review pipeline on Google ADK that autonomously fetches GitHub diffs, extracts structured PR context, and dispatches parallel specialist agents across Security, Logic, and Maintainability dimensions — posting formatted reviews via GitHub API.
- Designed a no-loop pipeline architecture (fetch → context → parallel analysis → synthesis → output) with Pydantic-enforced structured outputs at every stage, eliminating prompt optimization traps common in iterative agent designs.
- Implemented parallel specialist agents with dimension-isolated prompts producing severity-graded `ReviewItem` objects, synthesized into a final verdict with blocking/warning/suggestion tiers — a depth-over-speed alternative to single-call review tools.

---

## Why This Is Impressive to Interviewers

1. **Real tool use** — GitHub API, not a toy dataset
2. **Parallel agent orchestration** — same pattern as production agentic systems
3. **Structured outputs throughout** — shows you understand reliability in LLM pipelines
4. **Deliberate architecture decisions** — no loops, isolated concerns, clean session state flow
5. **Demonstrable output** — you can show an actual GitHub PR with the bot's comment in 60 seconds