/**
 * Integration tests — hit real OpenAI API.
 * Skipped automatically when OPENAI_API_KEY is not set.
 * Run with: npx vitest run tests/llm/llm-agent.integration.test.ts
 */
import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { config } from 'dotenv'
import { loadFixture } from '../../src/fixtures/loader.js'
import { runLLMAgent } from '../../src/agents/llm/index.js'

config()  // load .env

const FIXTURE_DIR = resolve('tests/fixtures-data/pr-001-hardcoded-secret')
const apiKey = process.env.OPENAI_API_KEY

describe.skipIf(!apiKey)('LLMAgent — real OpenAI (gpt-4o-mini)', () => {
  it('summarize: returns summary finding + question findings', async () => {
    const job = await loadFixture(FIXTURE_DIR, {
      command: 'summarize',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmApiKey: apiKey!,
    })

    const result = await runLLMAgent(job)

    expect(result.agent).toBe('LLMAgent')
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.trace.error).toBeUndefined()
    expect(result.trace.timed_out).toBe(false)

    const summary = result.findings.find((f) => f.severity !== 'QUESTION')
    expect(summary).toBeDefined()
    expect(summary!.message).toBeTruthy()

    console.log('\n--- Summary finding ---')
    console.log(summary!.message)
    console.log('--- Tokens used ---', result.metadata?.tokens_used)
  }, 30_000)

  it('ask: answers a specific question about the diff', async () => {
    const job = await loadFixture(FIXTURE_DIR, {
      command: 'ask',
      question: 'What secrets are hardcoded in this PR?',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmApiKey: apiKey!,
    })

    const result = await runLLMAgent(job)

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.severity).toBe('PASS')
    expect(result.findings[0]!.message).toContain('What secrets')

    console.log('\n--- Ask answer ---')
    console.log(result.findings[0]!.message)
    console.log('--- Tokens used ---', result.metadata?.tokens_used)
  }, 30_000)
})
