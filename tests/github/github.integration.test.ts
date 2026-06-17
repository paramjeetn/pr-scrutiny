/**
 * Integration test — hits real GitHub API + real OpenAI.
 * Skipped when GITHUB_TOKEN or OPENAI_API_KEY is not set.
 *
 * Run: npx vitest run tests/github/github.integration.test.ts
 */
import { describe, it, expect } from 'vitest'
import { config } from 'dotenv'
import { assembleContext } from '../../src/github/context.js'
import { runOrchestrator } from '../../src/orchestrator/index.js'
import { CommentPoster } from '../../src/github/poster.js'

config()

const githubToken = process.env.GITHUB_TOKEN
const openaiKey = process.env.OPENAI_API_KEY
const canRun = !!githubToken && !!openaiKey

const TEST_REPO = 'paramjeetn/pr-scrutiny-test-repo'
const TEST_PR = 1

describe.skipIf(!canRun)('GitHub integration — real PR review', () => {
  it('assembles ReviewJob from real GitHub PR', async () => {
    const job = await assembleContext(TEST_REPO, TEST_PR, {
      command: 'review:security',
      installationToken: githubToken!,
      llmApiKey: openaiKey!,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    })

    console.log(`\nPR: #${job.pr.number} — ${job.pr.title}`)
    console.log(`Files changed: ${job.diff.length}`)
    console.log(`Repo tree size: ${job.repo_tree.length}`)
    console.log(`Related files: ${job.related_files.length}`)
    console.log(`Diff files: ${job.diff.map(d => d.path).join(', ')}`)

    expect(job.pr.number).toBe(TEST_PR)
    expect(job.pr.repo).toBe(TEST_REPO)
    expect(job.diff.length).toBeGreaterThan(0)
    expect(job.repo_tree.length).toBeGreaterThan(0)
    expect(job.changed_files.length).toBeGreaterThan(0)
  }, 30_000)

  it('runs security agent on real PR diff', async () => {
    const job = await assembleContext(TEST_REPO, TEST_PR, {
      command: 'review:security',
      installationToken: githubToken!,
      llmApiKey: openaiKey!,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    })

    const { review, trace } = await runOrchestrator(job)

    console.log(`\nFindings: ${trace.total_findings}`)
    console.log(`Inline comments: ${review.inline.length}`)
    console.log(`Agent: ${trace.agents[0]?.agent} — ${trace.agents[0]?.duration_ms}ms`)
    console.log('\n--- Summary preview (first 500 chars) ---')
    console.log(review.summary.slice(0, 500))

    expect(review.summary).toContain('## PR Scrutiny')
    expect(trace.agents[0]?.agent).toBe('SecurityAgent')
    expect(trace.agents[0]?.timed_out).toBe(false)
  }, 60_000)

  it('posts real review comment to PR #1 (blast-radius only — no LLM)', async () => {
    const job = await assembleContext(TEST_REPO, TEST_PR, {
      command: 'blast-radius',
      installationToken: githubToken!,
      llmApiKey: openaiKey!,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
    })

    const { review } = await runOrchestrator(job)
    const poster = new CommentPoster(githubToken!, TEST_REPO)

    // Post just the summary (no inline — blast-radius findings have no line numbers)
    const commentId = await poster.postSummary(TEST_PR, review.summary)

    console.log(`\nPosted comment ID: ${commentId}`)
    console.log(`View at: https://github.com/${TEST_REPO}/pull/${TEST_PR}`)

    expect(commentId).toBeGreaterThan(0)
  }, 60_000)
})
