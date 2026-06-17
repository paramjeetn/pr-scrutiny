import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { loadFixture } from '../../src/fixtures/loader.js'
import { runLLMAgent } from '../../src/agents/llm/index.js'
import { runSummaryPass } from '../../src/agents/llm/summary.js'
import { runQuestionsPass } from '../../src/agents/llm/questions.js'
import { runAskPass } from '../../src/agents/llm/ask.js'
import type { LanguageModel } from 'ai'

const FIXTURE_DIR = resolve('tests/fixtures-data/pr-001-hardcoded-secret')

// ─── Mock model factory ─────────────────────────────────────────────────────
// Returns a LanguageModel that resolves to fixed text without hitting any API.
// Exercises real generateText() → doGenerate() path in Vercel AI SDK.

function makeMockModel(responseText: string): LanguageModel {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text: responseText }],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      rawCall: { rawPrompt: '', rawSettings: {} },
    }),
    doStream: async () => {
      throw new Error('streaming not used')
    },
  } as unknown as LanguageModel
}

// ─── Summary pass ───────────────────────────────────────────────────────────

describe('SummaryPass', () => {
  it('parses valid JSON response', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const mockResponse = JSON.stringify({
      what: 'Adds database connection pooling.',
      why: 'Improves performance under load.',
      risk: 'medium',
      risk_reason: 'Changes shared DB layer used by all routes.',
    })
    const { finding, tokens, summary } = await runSummaryPass(job, makeMockModel(mockResponse))

    expect(summary.what).toBe('Adds database connection pooling.')
    expect(summary.risk).toBe('medium')
    expect(finding.severity).toBe('SUGGEST')
    expect(finding.message).toContain('Adds database connection pooling')
    expect(tokens).toBe(150)
  })

  it('falls back gracefully on malformed JSON', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const { finding, summary } = await runSummaryPass(
      job,
      makeMockModel('This PR adds a new user endpoint.')
    )

    expect(finding.severity).toBe('SUGGEST')  // default medium risk
    expect(summary.risk).toBe('medium')
    expect(summary.what).toBeTruthy()
  })

  it('maps risk=low to PASS', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const { finding } = await runSummaryPass(
      job,
      makeMockModel(JSON.stringify({ what: 'x', why: 'y', risk: 'low', risk_reason: 'z' }))
    )
    expect(finding.severity).toBe('PASS')
  })

  it('maps risk=medium to SUGGEST', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const { finding } = await runSummaryPass(
      job,
      makeMockModel(JSON.stringify({ what: 'x', why: 'y', risk: 'medium', risk_reason: 'z' }))
    )
    expect(finding.severity).toBe('SUGGEST')
  })

  it('maps risk=high to WARN', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const { finding } = await runSummaryPass(
      job,
      makeMockModel(JSON.stringify({ what: 'x', why: 'y', risk: 'high', risk_reason: 'z' }))
    )
    expect(finding.severity).toBe('WARN')
  })
})

// ─── Questions pass ─────────────────────────────────────────────────────────

describe('QuestionsPass', () => {
  it('parses JSON array of questions', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const { findings, tokens } = await runQuestionsPass(
      job,
      makeMockModel(JSON.stringify(['Is this backward compatible?', 'Were integration tests run?']))
    )

    expect(findings).toHaveLength(2)
    expect(findings[0]!.severity).toBe('QUESTION')
    expect(findings[0]!.message).toBe('Is this backward compatible?')
    expect(tokens).toBe(150)
  })

  it('falls back on non-JSON: extracts question lines', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const { findings } = await runQuestionsPass(
      job,
      makeMockModel('1. Was this tested in staging?\n2. Does this affect the mobile API?')
    )

    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every((f) => f.severity === 'QUESTION')).toBe(true)
  })

  it('returns empty findings for empty array response', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const { findings } = await runQuestionsPass(job, makeMockModel('[]'))
    expect(findings).toHaveLength(0)
  })
})

// ─── Ask pass ───────────────────────────────────────────────────────────────

describe('AskPass', () => {
  it('wraps answer in PASS finding', async () => {
    const job = await loadFixture(FIXTURE_DIR, { command: 'ask', question: 'Is this safe?' })
    const { finding, tokens } = await runAskPass(
      job,
      makeMockModel('Based on the diff, this introduces a hardcoded secret.')
    )

    expect(finding.severity).toBe('PASS')
    expect(finding.message).toContain('Is this safe?')
    expect(finding.message).toContain('hardcoded secret')
    expect(tokens).toBe(150)
  })

  it('uses default question when none provided', async () => {
    const job = await loadFixture(FIXTURE_DIR, { command: 'ask' })
    const { finding } = await runAskPass(
      job,
      makeMockModel('This PR modifies the DB connection layer.')
    )
    expect(finding.message).toContain('Summarize this PR')
  })
})

// ─── Full agent (via model override — no real API calls) ────────────────────

describe('LLMAgent — full run', () => {
  const summaryResponse = JSON.stringify({
    what: 'Adds user route.',
    why: 'Feature request.',
    risk: 'low',
    risk_reason: 'Isolated change.',
  })

  it('returns valid AgentResult shape', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runLLMAgent(job, makeMockModel(summaryResponse))

    expect(result.agent).toBe('LLMAgent')
    expect(Array.isArray(result.findings)).toBe(true)
    expect(result.trace).toMatchObject({
      agent: 'LLMAgent',
      started_at: expect.any(String),
      duration_ms: expect.any(Number),
      finding_count: expect.any(Number),
      timed_out: false,
    })
    expect(result.trace.finding_count).toBe(result.findings.length)
    expect(result.metadata).toHaveProperty('tokens_used')
  })

  it('handles model error gracefully — returns empty findings not throw', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const errorModel = {
      specificationVersion: 'v2',
      provider: 'mock',
      modelId: 'error-model',
      supportedUrls: {},
      doGenerate: async () => { throw new Error('401 Unauthorized') },
      doStream: async () => { throw new Error('401 Unauthorized') },
    } as unknown as LanguageModel

    const result = await runLLMAgent(job, errorModel)

    expect(result.agent).toBe('LLMAgent')
    expect(result.findings).toHaveLength(0)
    expect(result.trace.error).toContain('401')
    expect(result.trace.timed_out).toBe(false)
  })

  it('ask command returns single PASS finding', async () => {
    const job = await loadFixture(FIXTURE_DIR, {
      command: 'ask',
      question: 'What does db.js export?',
    })
    const result = await runLLMAgent(
      job,
      makeMockModel('db.js exports a pool object for database connections.')
    )

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.severity).toBe('PASS')
  })

  it('review command returns summary + questions findings', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runLLMAgent(job, makeMockModel(summaryResponse))

    // summary finding + question findings (empty array from mock, so just summary)
    expect(result.findings.length).toBeGreaterThanOrEqual(1)
  })

  it('all findings have valid severity + message', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runLLMAgent(job, makeMockModel(summaryResponse))

    for (const f of result.findings) {
      expect(f.severity).toMatch(/^(HOLD|WARN|SUGGEST|PASS|QUESTION)$/)
      expect(f.message).toBeTruthy()
    }
  })

  it('metadata.tokens_used is a number', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runLLMAgent(job, makeMockModel(summaryResponse))
    expect(typeof result.metadata?.tokens_used).toBe('number')
  })

  it('trace duration is non-negative', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runLLMAgent(job, makeMockModel(summaryResponse))
    expect(result.trace.duration_ms).toBeGreaterThanOrEqual(0)
  })
})
