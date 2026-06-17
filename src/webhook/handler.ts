import type { Context } from 'hono'
import { verifySignature } from './hmac.js'
import { parseSlashCommand, parseWebhookContext } from './parser.js'
import {
  isDeliverySeen, markDeliverySeen,
  jobKey, isJobActive, claimJob, releaseJob,
} from './idempotency.js'

// Injected at server startup — set via environment variables
let webhookSecret = ''
export function setWebhookSecret(s: string) { webhookSecret = s }

// ─── Stub: will be replaced in Phase 8 with real GitHub + orchestrator logic ─

async function processJob(
  installationId: number,
  repo: string,
  prNumber: number,
  headSha: string,
  command: string,
  question: string | undefined
): Promise<void> {
  // Phase 7 stub — logs only. Phase 8 wires this to context assembler + orchestrator.
  console.log(`[job] ${command} on ${repo}#${prNumber} @ ${headSha.slice(0, 7)} (install=${installationId})${question ? ` q="${question}"` : ''}`)
}

// ─── Webhook handler ─────────────────────────────────────────────────────────

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
  let command = 'review'
  let question: string | undefined

  if (isSlashCommand) {
    if (!ctx.commentBody) return c.json({ ok: true, skipped: 'empty_comment' })
    const parsed = parseSlashCommand(ctx.commentBody)
    if (!parsed) return c.json({ ok: true, skipped: 'not_a_slash_command' })
    command = parsed.command
    question = parsed.question
  }
  // isPRSync → default 'review' (auto-review on PR open/sync)

  // 8. Job dedup — need a headSha (for PR sync events we have it; for slash commands use pr number as key)
  const sha = ctx.headSha ?? `comment-${deliveryId}`
  const key = jobKey(ctx.repo, ctx.prNumber, sha)

  if (isJobActive(key)) {
    return c.json({ ok: true, skipped: 'job_already_running' })
  }

  // 9. Return 200 immediately, process async
  claimJob(key)
  setImmediate(async () => {
    try {
      await processJob(ctx.installationId, ctx.repo, ctx.prNumber!, sha, command, question)
    } finally {
      releaseJob(key)
    }
  })

  return c.json({ ok: true, queued: true, command, repo: ctx.repo, pr: ctx.prNumber })
}
