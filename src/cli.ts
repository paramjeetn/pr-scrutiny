#!/usr/bin/env node
/**
 * PR Scrutiny CLI — local dev entrypoint
 *
 * Usage:
 *   npx tsx src/cli.ts review        ./tests/fixtures-data/pr-001-hardcoded-secret
 *   npx tsx src/cli.ts summarize     ./tests/fixtures-data/pr-001-hardcoded-secret
 *   npx tsx src/cli.ts blast-radius  ./tests/fixtures-data/pr-001-hardcoded-secret
 *   npx tsx src/cli.ts ask           ./tests/fixtures-data/pr-001-hardcoded-secret "What secrets are hardcoded?"
 */
import { resolve } from 'node:path'
import { config } from 'dotenv'
import { loadFixture } from './fixtures/loader.js'
import { runOrchestrator } from './orchestrator/index.js'
import type { Command } from './types/index.js'

config()  // load .env

const VALID_COMMANDS: Command[] = [
  'review', 'review:security', 'review:perf',
  'summarize', 'ask', 'blast-radius', 're-review',
]

async function main() {
  const [, , rawCommand, rawFixtureDir, ...rest] = process.argv

  if (!rawCommand || !rawFixtureDir) {
    console.error('Usage: npx tsx src/cli.ts <command> <fixture-dir> [question]')
    console.error('Commands:', VALID_COMMANDS.join(' | '))
    process.exit(1)
  }

  const command = rawCommand as Command
  if (!VALID_COMMANDS.includes(command)) {
    console.error(`Unknown command: ${command}`)
    console.error('Valid commands:', VALID_COMMANDS.join(' | '))
    process.exit(1)
  }

  const fixtureDir = resolve(rawFixtureDir)
  const question = rest[0]

  // LLM config from env (optional — only needed for LLM commands)
  const llmProvider = (process.env.LLM_PROVIDER ?? 'openai') as 'openai' | 'anthropic' | 'google'
  const llmModel = process.env.LLM_MODEL ?? 'gpt-4o-mini'
  const llmApiKey = process.env.OPENAI_API_KEY
    ?? process.env.ANTHROPIC_API_KEY
    ?? process.env.GOOGLE_API_KEY
    ?? ''

  console.error(`Loading fixture: ${fixtureDir}`)
  const job = await loadFixture(fixtureDir, {
    command,
    question,
    llmProvider,
    llmModel,
    llmApiKey,
  })

  console.error(`Running command: ${command} (PR #${job.pr.number} — ${job.pr.title})`)
  console.error(`Agents: will dispatch based on command...`)
  console.error()

  const { review, trace } = await runOrchestrator(job)

  // Print formatted review to stdout
  console.log(review.summary)

  if (review.inline.length > 0) {
    console.log('\n---\n')
    console.log(`## Inline comments (${review.inline.length})`)
    for (const c of review.inline) {
      console.log(`\n**${c.path}:${c.line}**`)
      console.log(c.body)
    }
  }

  // Print timing summary to stderr
  console.error()
  console.error('─── Trace ───')
  for (const a of trace.agents) {
    const status = a.timed_out ? 'TIMEOUT' : a.error ? `ERROR: ${a.error}` : 'OK'
    console.error(`  ${a.agent}: ${a.duration_ms}ms, ${a.finding_count} findings [${status}]`)
  }
  console.error(`  Total: ${trace.duration_ms}ms, ${trace.total_findings} findings`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
