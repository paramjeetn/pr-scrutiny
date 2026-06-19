# Architecture Diagram — Generation Prompt

Use this prompt with an AI image generation tool (e.g. DALL-E, Midjourney, Ideogram, or a diagramming AI like Eraser.io or Whimsical AI).

---

## Prompt

Create a clean, modern software architecture diagram in a dark-themed startup/open-source style (dark navy or near-black background, similar to GitHub's dark mode or Vercel's design system).

The diagram should show the following flow, left to right:

**Left side — Trigger:**
- A GitHub pull request icon with two entry points:
  - "PR opened / pushed" (automatic)
  - "/review comment" (manual slash command)

**Center-left — Webhook Layer (Google Cloud Run):**
- A box labeled "PR Scrutiny" / "Cloud Run"
- Inside it, show these steps stacked vertically:
  1. HMAC Signature Verify
  2. Webhook Dedup (Firestore)
  3. Return 200 immediately
  4. Post provisional comment → GitHub

**Center — Agent Pipeline (parallel):**
- Four agent boxes running in parallel, connected by a fork/join arrow:
  - Security Agent (shield icon) — "Secrets · Injection · Auth · CVEs"
  - Quality Agent (checkmark icon) — "N+1 · Complexity · Coverage"
  - Blast Radius Agent (explosion icon) — "Import graph · Routes · Config"
  - LLM Agent (AI/sparkle icon) — "Summary · Questions · /ask"
- Each box shows a timeout: Security/Quality/BlastRadius = 30s, LLM = 60s

**Center-right — Orchestrator:**
- A box labeled "Orchestrator"
- Shows: Aggregate → Deduplicate → Sort by severity → Format Markdown

**Right side — Output back to GitHub:**
- GitHub PR icon showing:
  - Inline comments on specific diff lines
  - Summary comment (with severity breakdown)
  - Delete provisional comment

**Bottom — Storage layer (runs throughout):**
- Google Firestore box connected to the Cloud Run box with dotted lines
- Labels: "Installation config (KMS-encrypted API key)" / "Job dedup" / "Webhook dedup"
- Google Cloud KMS box connected to Firestore

**Style requirements:**
- Dark background: #0d1117 or similar deep navy
- Accent colors: blue (#58a6ff) for arrows and highlights, purple (#a371f7) for agent boxes, green (#3fb950) for success outputs
- Clean sans-serif font (Inter or similar)
- Rounded rectangle boxes with subtle borders
- Arrows with directional labels
- Small icons inside boxes (shield, sparkle, lightning bolt, etc.)
- No drop shadows — flat design
- Overall feel: professional open-source project, similar to how Vercel, PlanetScale, or Supabase would present their architecture

**Size:** 1600x900px (16:9), suitable for a GitHub README

---

## Alternative: Eraser.io / Whimsical text prompt

If using a text-to-diagram tool (Eraser.io, Whimsical AI, Mermaid):

```
Title: PR Scrutiny — Architecture

GitHub (PR Event / Slash Command)
  --> Cloud Run: PR Scrutiny Server
      --> HMAC Verify
      --> Webhook Dedup [Firestore]
      --> Return 200
      --> Post Provisional Comment [GitHub API]
      --> Resolve Installation Token [GitHub Auth]
      --> Assemble Context [GitHub API]
          --> PR metadata, diff, file contents, repo tree
      --> Run Agents (parallel, 30-60s timeout each)
          --> Security Agent: secrets, injection, auth, CVEs
          --> Quality Agent: N+1, complexity, coverage, perf
          --> Blast Radius Agent: import graph, routes, config
          --> LLM Agent: summary, questions, /ask (customer API key)
      --> Orchestrator
          --> Aggregate findings
          --> Deduplicate by (file, line)
          --> Sort: HOLD > WARN > SUGGEST > PASS > QUESTION
          --> Format GitHub Markdown
      --> Post Review [GitHub API]
          --> Inline comments (batched)
          --> Summary comment
          --> Delete provisional comment

Storage (Firestore):
  - installations/{id}: provider, model, KMS-encrypted API key
  - idempotency/{delivery_id}: webhook dedup (24h)
  - jobs/{repo:pr:sha}: job dedup (4h)

Secrets:
  - Google Cloud KMS: encrypts/decrypts customer API keys
  - Secret Manager: GitHub App private key, webhook secret
```

---

## Key things to emphasize visually

1. The **parallel agent execution** (fork → 4 agents → join) is the core architectural idea
2. The **200 returned immediately** before heavy work starts (async processing)
3. The **provisional comment** posted early, deleted at the end (the UX loop)
4. **Customer API key** flows only to LLMAgent, not to static agents
5. **Firestore** underpins dedup and config, but is a background concern
