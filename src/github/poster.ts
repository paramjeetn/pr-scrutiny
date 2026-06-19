import { Octokit } from 'octokit'
import type { FormattedReview, InlineComment } from '../orchestrator/formatter.js'
import type { Command } from '../types/index.js'

// ─── Comment poster ──────────────────────────────────────────────────────────

export class CommentPoster {
  private octokit: Octokit
  private owner: string
  private repo: string

  constructor(installationToken: string, fullRepo: string) {
    this.octokit = new Octokit({ auth: installationToken })
    const [owner, repo] = fullRepo.split('/')
    if (!owner || !repo) throw new Error(`Invalid repo: ${fullRepo}`)
    this.owner = owner
    this.repo = repo
  }

  /** Post a provisional "working..." comment. Returns comment ID for later deletion. */
  async postProvisional(prNumber: number, command: Command): Promise<number> {
    const messages: Record<Command, string> = {
      'review':          '🔍 **PR Scrutiny** is reviewing this PR...',
      're-review':       '🔍 **PR Scrutiny** is reviewing this PR...',
      'review:security': '🔍 **PR Scrutiny** is reviewing this PR...',
      'review:perf':     '🔍 **PR Scrutiny** is reviewing this PR...',
      'summarize':       '📝 **PR Scrutiny** is summarizing this PR...',
      'ask':             '💬 **PR Scrutiny** is thinking...',
      'blast-radius':    '💥 **PR Scrutiny** is mapping blast radius...',
    }
    const { data } = await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      body: messages[command] ?? '🔍 **PR Scrutiny** is working...',
    })
    return data.id
  }

  /** Delete the provisional comment once the real review is ready. */
  async deleteComment(commentId: number): Promise<void> {
    try {
      await this.octokit.rest.issues.deleteComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: commentId,
      })
    } catch {
      // Non-fatal — provisional comment just stays visible
    }
  }

  /** Post top-level summary comment on the PR. */
  async postSummary(prNumber: number, summary: string): Promise<number> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      body: summary,
    })
    return data.id
  }

  /**
   * Post inline review comments as a single batched review.
   * GitHub requires a valid commit SHA and file line number.
   */
  async postInlineReview(
    prNumber: number,
    headSha: string,
    inline: InlineComment[]
  ): Promise<void> {
    if (inline.length === 0) return

    const comments = inline.map((c) => ({
      path: c.path,
      line: c.line,
      body: c.body,
      side: 'RIGHT' as const,
    }))

    await this.octokit.rest.pulls.createReview({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: 'COMMENT',
      comments,
    })
  }

  /**
   * Full post flow: delete provisional → post inline + summary.
   * provisionalId: ID of the "working..." comment posted before the job started.
   * Falls back gracefully — if inline review fails, summary still posts.
   */
  async postReview(
    prNumber: number,
    headSha: string,
    review: FormattedReview,
    provisionalId: number
  ): Promise<void> {
    try {
      // Inline comments first (batched)
      if (review.inline.length > 0) {
        try {
          await this.postInlineReview(prNumber, headSha, review.inline)
        } catch (err) {
          console.warn('[poster] Inline review failed, posting summary only:', err)
        }
      }

      // Top-level summary
      await this.postSummary(prNumber, review.summary)
    } finally {
      await this.deleteComment(provisionalId)
    }
  }
}
