import type { Command } from '../types/index.js'

// ─── Slash command parsing ───────────────────────────────────────────────────

const VALID_COMMANDS: Command[] = [
  'review', 'review:security', 'review:perf',
  'summarize', 'ask', 'blast-radius', 're-review',
]

export interface ParsedCommand {
  command: Command
  question?: string   // only for /ask
}

/**
 * Parse a slash command from a PR comment body.
 * Returns null if the comment doesn't start with a recognized /command.
 *
 * Examples:
 *   /review                     → { command: 'review' }
 *   /review:security            → { command: 'review:security' }
 *   /ask What does db.js do?    → { command: 'ask', question: 'What does db.js do?' }
 *   /summarize                  → { command: 'summarize' }
 */
export function parseSlashCommand(body: string): ParsedCommand | null {
  const trimmed = body.trim()
  if (!trimmed.startsWith('/')) return null

  // First word is the command (strip leading slash)
  const firstLine = trimmed.split('\n')[0]!.trim()
  const [rawCmd, ...rest] = firstLine.split(/\s+/)
  const cmd = rawCmd!.slice(1)  // strip '/'

  if (!VALID_COMMANDS.includes(cmd as Command)) return null

  const command = cmd as Command
  const question = command === 'ask' && rest.length > 0
    ? rest.join(' ').trim() || undefined
    : undefined

  return { command, question }
}

// ─── Webhook event parsing ───────────────────────────────────────────────────

export type GitHubEventType =
  | 'pull_request'
  | 'issue_comment'
  | 'pull_request_review'
  | 'ping'
  | 'unknown'

export interface WebhookContext {
  eventType: GitHubEventType
  deliveryId: string
  installationId: number
  repo: string          // "owner/repo"
  prNumber: number | null
  action: string | null
  // For slash commands (issue_comment)
  commentBody?: string
  commenterLogin?: string
  // For PR events
  headSha?: string
  baseBranch?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseWebhookContext(eventType: string, deliveryId: string, body: any): WebhookContext {
  const knownEvent = (['pull_request', 'issue_comment', 'pull_request_review', 'ping'] as const)
    .includes(eventType as GitHubEventType)
    ? eventType as GitHubEventType
    : 'unknown'

  const installationId: number = body?.installation?.id ?? 0
  const repo: string = body?.repository?.full_name ?? ''
  const action: string | null = body?.action ?? null

  let prNumber: number | null = null
  let commentBody: string | undefined
  let commenterLogin: string | undefined
  let headSha: string | undefined
  let baseBranch: string | undefined

  if (knownEvent === 'issue_comment') {
    // Slash commands arrive as issue_comment on a PR
    prNumber = body?.issue?.number ?? null
    commentBody = body?.comment?.body ?? undefined
    commenterLogin = body?.comment?.user?.login ?? undefined
    // Only treat as PR comment if issue has pull_request key
    if (!body?.issue?.pull_request) prNumber = null
  } else if (knownEvent === 'pull_request') {
    prNumber = body?.pull_request?.number ?? null
    headSha = body?.pull_request?.head?.sha ?? undefined
    baseBranch = body?.pull_request?.base?.ref ?? undefined
  } else if (knownEvent === 'pull_request_review') {
    prNumber = body?.pull_request?.number ?? null
    headSha = body?.pull_request?.head?.sha ?? undefined
  }

  return {
    eventType: knownEvent,
    deliveryId,
    installationId,
    repo,
    prNumber,
    action,
    commentBody,
    commenterLogin,
    headSha,
    baseBranch,
  }
}
