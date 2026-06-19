import type { Context } from 'hono'
import { verifySignature } from './hmac.js'
import { parseSlashCommand, parseWebhookContext } from './parser.js'
import {
  isDeliverySeen, markDeliverySeen,
  jobKey, isJobActive, claimJob, releaseJob,
} from './idempotency.js'
import { assembleContext } from '../github/context.js'
import { CommentPoster } from '../github/poster.js'
import { runOrchestrator } from '../orchestrator/index.js'
import type { Command, LLMProvider } from '../types/index.js'
import { getInstallation } from '../storage/installations.js'

// Injected at server startup — set via environment variables
let webhookSecret = ''
export function setWebhookSecret(s: string) { webhookSecret = s }

// ─── Config read from env at runtime (dev fallback) ──────────────────────────

function getLLMConfigFromEnv(): { apiKey: string; provider: LLMProvider; model: string } {
  const provider = (process.env['LLM_PROVIDER'] ?? 'openai') as LLMProvider
  const model = process.env['LLM_MODEL'] ?? 'gpt-4o-mini'
  const apiKey = process.env['OPENAI_API_KEY']
    ?? process.env['ANTHROPIC_API_KEY']
    ?? process.env['GOOGLE_API_KEY']
    ?? ''
  return { provider, model, apiKey }
}

// ─── Core job processor ───────────────────────────────────────────────────────

async function processJob(
  installationToken: string,
  installationId: number,
  repo: string,
  prNumber: number,
  headSha: string,
  command: Command,
  question: string | undefined
): Promise<void> {
  console.log(`[job] start ${command} ${repo}#${prNumber} @ ${headSha.slice(0, 7)}`)

  const poster = new CommentPoster(installationToken, repo)

  // Post provisional immediately — before any slow Firestore/API calls
  const provisionalId = await poster.postProvisional(prNumber, command).catch(() => 0)

  // Try Firestore installation config first, fall back to env vars (dev)
  let llm: { apiKey: string; provider: LLMProvider; model: string }
  const installation = await getInstallation(installationId).catch(() => null)
  if (installation?.active && installation.api_key) {
    llm = { apiKey: installation.api_key, provider: installation.provider, model: installation.model }
  } else {
    llm = getLLMConfigFromEnv()
  }

  try {
    // Assemble context from GitHub API
    const job = await assembleContext(repo, prNumber, {
      command,
      question,
      installationToken,
      llmApiKey: llm.apiKey,
      llmProvider: llm.provider,
      llmModel: llm.model,
    })
    job.pr.head_sha = headSha

    // Run all agents
    const { review } = await runOrchestrator(job)

    // Post results to GitHub (deletes provisional in finally)
    await poster.postReview(prNumber, headSha, review, provisionalId)

    console.log(`[job] done ${command} ${repo}#${prNumber}`)
  } catch (err) {
    console.error(`[job] error ${repo}#${prNumber}:`, err)
    // Delete provisional + post error comment
    if (provisionalId) await poster.deleteComment(provisionalId)
    try {
      await poster.postSummary(prNumber,
        `## PR Scrutiny\n\n❌ Review failed: ${err instanceof Error ? err.message : String(err)}\n\nPlease try again or contact support.`
      )
    } catch {
      // ignore secondary failure
    }
  }
}

// ─── Webhook handler ─────────────────────────────────────────────────────────

// Token resolver — uses GitHub App JWT flow in production, falls back to GITHUB_TOKEN env var for dev.
// In production: App ID + private key are in Secret Manager; getInstallationToken() exchanges them.
// In dev: set GITHUB_TOKEN in .env (personal access token with repo scope).
async function resolveInstallationToken(installationId: number): Promise<string | null> {
  // Production path: use GitHub App credentials from env/Secret Manager
  const appId      = process.env['GITHUB_APP_ID']
  const privateKey = process.env['GITHUB_APP_PRIVATE_KEY']
  if (appId && privateKey) {
    const { getInstallationToken } = await import('../github/auth.js')
    return getInstallationToken(appId, privateKey, installationId)
  }

  // Dev fallback: plain personal access token
  return process.env['GITHUB_TOKEN'] ?? null
}

export async function handleWebhook(c: Context): Promise<Response> {
  const rawBody = await c.req.text()
  const signature = c.req.header('x-hub-signature-256')
  const eventType = c.req.header('x-github-event') ?? 'unknown'
  const deliveryId = c.req.header('x-github-delivery') ?? ''

  // 1. HMAC validation (skip if no secret configured — local dev without a real App)
  if (webhookSecret) {
    if (!verifySignature(rawBody, signature, webhookSecret)) {
      return c.text('Unauthorized', 401)
    }
  }

  // Parse body
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return c.text('Bad Request', 400)
  }

  // 2. Ping → ack immediately
  if (eventType === 'ping') {
    return c.json({ ok: true, message: 'pong' })
  }

  // 3. Webhook dedup
  if (deliveryId && isDeliverySeen(deliveryId)) {
    return c.json({ ok: true, skipped: 'duplicate_delivery' })
  }
  if (deliveryId) markDeliverySeen(deliveryId)

  // 4. Parse event context
  const ctx = parseWebhookContext(eventType, deliveryId, body)

  // 5. Only handle slash commands (issue_comment.created) and PR sync
  const isSlashCommand = ctx.eventType === 'issue_comment' && ctx.action === 'created'
  const isPRSync = ctx.eventType === 'pull_request' &&
    (ctx.action === 'opened' || ctx.action === 'synchronize' || ctx.action === 'reopened')

  if (!isSlashCommand && !isPRSync) {
    return c.json({ ok: true, skipped: 'unhandled_event' })
  }

  // 6. Need a valid PR number
  if (!ctx.prNumber) {
    return c.json({ ok: true, skipped: 'no_pr_number' })
  }

  // 7. Determine command
  let command: Command = 'review'
  let question: string | undefined

  if (isSlashCommand) {
    if (!ctx.commentBody) return c.json({ ok: true, skipped: 'empty_comment' })
    const parsed = parseSlashCommand(ctx.commentBody)
    if (!parsed) return c.json({ ok: true, skipped: 'not_a_slash_command' })
    command = parsed.command
    question = parsed.question
  }

  // 8. Job dedup — slash commands don't carry headSha, use command as suffix so
  // /review on the same PR won't double-run if a PR sync event fires simultaneously
  const sha = ctx.headSha ?? `${command}-${ctx.prNumber}`
  const key = jobKey(ctx.repo, ctx.prNumber, sha)

  if (isJobActive(key)) {
    return c.json({ ok: true, skipped: 'job_already_running' })
  }

  // 9. Resolve installation token (Phase 9: Firestore + KMS; now: env var)
  const token = await resolveInstallationToken(ctx.installationId)
  if (!token) {
    console.warn(`[webhook] No token for installation ${ctx.installationId} — skipping`)
    return c.json({ ok: true, skipped: 'no_installation_token' })
  }

  // 10. Return 200 immediately, process async
  claimJob(key)
  setImmediate(async () => {
    try {
      await processJob(token, ctx.installationId, ctx.repo, ctx.prNumber!, sha, command, question)
    } finally {
      releaseJob(key)
    }
  })

  return c.json({ ok: true, queued: true, command, repo: ctx.repo, pr: ctx.prNumber })
}
