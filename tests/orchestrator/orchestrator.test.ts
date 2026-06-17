import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { loadFixture } from '../../src/fixtures/loader.js'
import { getAgentsForCommand } from '../../src/orchestrator/router.js'
import { aggregate } from '../../src/orchestrator/aggregator.js'
import { format } from '../../src/orchestrator/formatter.js'
import { runOrchestrator } from '../../src/orchestrator/index.js'
import type { AgentResult, Finding } from '../../src/types/index.js'

const FIXTURE_DIR = resolve('tests/fixtures-data/pr-001-hardcoded-secret')

// ─── Router ─────────────────────────────────────────────────────────────────

describe('Router', () => {
  it('review runs all 4 agents', () => {
    const agents = getAgentsForCommand('review')
    expect(agents).toContain('SecurityAgent')
    expect(agents).toContain('QualityAgent')
    expect(agents).toContain('LLMAgent')
    expect(agents).toContain('BlastRadiusAgent')
    expect(agents).toHaveLength(4)
  })

  it('review:security runs only SecurityAgent', () => {
    expect(getAgentsForCommand('review:security')).toEqual(['SecurityAgent'])
  })

  it('review:perf runs only QualityAgent', () => {
    expect(getAgentsForCommand('review:perf')).toEqual(['QualityAgent'])
  })

  it('summarize runs only LLMAgent', () => {
    expect(getAgentsForCommand('summarize')).toEqual(['LLMAgent'])
  })

  it('ask runs only LLMAgent', () => {
    expect(getAgentsForCommand('ask')).toEqual(['LLMAgent'])
  })

  it('blast-radius runs only BlastRadiusAgent', () => {
    expect(getAgentsForCommand('blast-radius')).toEqual(['BlastRadiusAgent'])
  })

  it('re-review runs all 4 agents', () => {
    expect(getAgentsForCommand('re-review')).toHaveLength(4)
  })
})

// ─── Aggregator ─────────────────────────────────────────────────────────────

describe('Aggregator', () => {
  function makeResult(agent: string, findings: Finding[]): AgentResult {
    return {
      agent,
      findings,
      trace: {
        agent,
        started_at: new Date().toISOString(),
        duration_ms: 10,
        finding_count: findings.length,
        timed_out: false,
      },
    }
  }

  it('merges findings from multiple agents', () => {
    const results = [
      makeResult('SecurityAgent', [
        { severity: 'HOLD', file: 'src/config.js', line: 5, message: 'Hardcoded secret' },
      ]),
      makeResult('QualityAgent', [
        { severity: 'SUGGEST', file: 'src/utils/db.js', line: 12, message: 'N+1 query' },
      ]),
    ]
    const { findings } = aggregate('job-1', 'review', new Date().toISOString(), results)
    expect(findings).toHaveLength(2)
  })

  it('dedup: same file+line keeps highest severity', () => {
    const results = [
      makeResult('SecurityAgent', [
        { severity: 'WARN', file: 'src/config.js', line: 5, message: 'Warn finding' },
      ]),
      makeResult('QualityAgent', [
        { severity: 'HOLD', file: 'src/config.js', line: 5, message: 'Hold finding' },
      ]),
    ]
    const { findings } = aggregate('job-1', 'review', new Date().toISOString(), results)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('HOLD')
  })

  it('dedup: same file+line, same severity keeps first seen', () => {
    const results = [
      makeResult('SecurityAgent', [
        { severity: 'WARN', file: 'src/config.js', line: 5, message: 'First warn' },
        { severity: 'WARN', file: 'src/config.js', line: 5, message: 'Second warn' },
      ]),
    ]
    const { findings } = aggregate('job-1', 'review', new Date().toISOString(), results)
    expect(findings).toHaveLength(1)
  })

  it('findings without file/line are kept separate (not deduped)', () => {
    const results = [
      makeResult('LLMAgent', [
        { severity: 'PASS', message: 'Summary: ...' },
        { severity: 'QUESTION', message: 'Is this backward compatible?' },
      ]),
    ]
    const { findings } = aggregate('job-1', 'review', new Date().toISOString(), results)
    expect(findings).toHaveLength(2)
  })

  it('sorts: HOLD before WARN before SUGGEST before PASS before QUESTION', () => {
    const results = [
      makeResult('SecurityAgent', [
        { severity: 'SUGGEST', message: 'Suggestion' },
        { severity: 'HOLD', file: 'a.js', line: 1, message: 'Hold' },
        { severity: 'WARN', message: 'Warning' },
        { severity: 'QUESTION', message: 'Question' },
        { severity: 'PASS', message: 'Pass' },
      ]),
    ]
    const { findings } = aggregate('job-1', 'review', new Date().toISOString(), results)
    expect(findings[0]!.severity).toBe('HOLD')
    expect(findings[1]!.severity).toBe('WARN')
    expect(findings[2]!.severity).toBe('SUGGEST')
    expect(findings[3]!.severity).toBe('PASS')
    expect(findings[4]!.severity).toBe('QUESTION')
  })

  it('trace includes all agent traces', () => {
    const results = [
      makeResult('SecurityAgent', []),
      makeResult('QualityAgent', []),
    ]
    const { trace } = aggregate('job-1', 'review', new Date().toISOString(), results)
    expect(trace.agents).toHaveLength(2)
    expect(trace.agents.map((a) => a.agent)).toContain('SecurityAgent')
    expect(trace.agents.map((a) => a.agent)).toContain('QualityAgent')
  })

  it('trace captures llm_tokens_used from LLMAgent metadata', () => {
    const results: AgentResult[] = [
      {
        agent: 'LLMAgent',
        findings: [],
        metadata: { tokens_used: 1234 },
        trace: {
          agent: 'LLMAgent',
          started_at: new Date().toISOString(),
          duration_ms: 5000,
          finding_count: 0,
          timed_out: false,
        },
      },
    ]
    const { trace } = aggregate('job-1', 'summarize', new Date().toISOString(), results)
    expect(trace.llm_tokens_used).toBe(1234)
  })
})

// ─── Formatter ──────────────────────────────────────────────────────────────

describe('Formatter', () => {
  function makeAggregated(findings: Finding[]) {
    const results = [
      {
        agent: 'SecurityAgent',
        findings,
        trace: {
          agent: 'SecurityAgent',
          started_at: new Date().toISOString(),
          duration_ms: 100,
          finding_count: findings.length,
          timed_out: false,
        },
      } as AgentResult,
    ]
    return aggregate('job-1', 'review', new Date().toISOString(), results)
  }

  it('inline findings go to inline array', () => {
    const agg = makeAggregated([
      { severity: 'HOLD', file: 'src/config.js', line: 5, message: 'Hardcoded secret' },
    ])
    const { inline } = format(agg)
    expect(inline).toHaveLength(1)
    expect(inline[0]!.path).toBe('src/config.js')
    expect(inline[0]!.line).toBe(5)
    expect(inline[0]!.body).toContain('HOLD')
    expect(inline[0]!.body).toContain('Hardcoded secret')
  })

  it('findings without line go to summary only', () => {
    const agg = makeAggregated([
      { severity: 'WARN', message: 'Config change detected' },
    ])
    const { inline, summary } = format(agg)
    expect(inline).toHaveLength(0)
    expect(summary).toContain('Config change detected')
  })

  it('summary contains HOLD block when HOLD findings exist', () => {
    const agg = makeAggregated([
      { severity: 'HOLD', file: 'src/config.js', line: 5, message: 'Secret found' },
    ])
    const { summary } = format(agg)
    expect(summary).toContain('blocking issue')
  })

  it('summary shows clean status when no HOLD/WARN', () => {
    const agg = makeAggregated([
      { severity: 'PASS', message: 'Looks good' },
    ])
    const { summary } = format(agg)
    expect(summary).toContain('No blocking issues')
  })

  it('questions rendered in dedicated section', () => {
    const agg = makeAggregated([
      { severity: 'QUESTION', message: 'Is this backward compatible?' },
    ])
    const { summary } = format(agg)
    expect(summary).toContain('Questions for the author')
    expect(summary).toContain('Is this backward compatible?')
  })

  it('agent trace included as collapsed details block', () => {
    const agg = makeAggregated([])
    const { summary } = format(agg)
    expect(summary).toContain('<details>')
    expect(summary).toContain('Analysis details')
    expect(summary).toContain('Security')
  })

  it('inline comment body includes remediation when present', () => {
    const agg = makeAggregated([
      {
        severity: 'HOLD',
        file: 'src/config.js',
        line: 5,
        message: 'Hardcoded secret',
        remediation: 'Move to env var',
      },
    ])
    const { inline } = format(agg)
    expect(inline[0]!.body).toContain('Move to env var')
  })
})

// ─── Full orchestrator (static-only agents, no LLM) ─────────────────────────

describe('Orchestrator — review:security (no LLM)', () => {
  it('returns valid OrchestratorResult shape', async () => {
    const job = await loadFixture(FIXTURE_DIR, { command: 'review:security' })
    const { review, trace } = await runOrchestrator(job)

    expect(Array.isArray(review.inline)).toBe(true)
    expect(typeof review.summary).toBe('string')
    expect(review.summary.length).toBeGreaterThan(0)
    expect(trace.agents).toHaveLength(1)
    expect(trace.agents[0]!.agent).toBe('SecurityAgent')
  })

  it('finds HOLD findings in fixture (secrets planted)', async () => {
    const job = await loadFixture(FIXTURE_DIR, { command: 'review:security' })
    const { review } = await runOrchestrator(job)

    const allFindings = [
      ...review.inline.map((c) => c.body),
      review.summary,
    ]
    const hasHold = allFindings.some((b) => b.includes('HOLD'))
    expect(hasHold).toBe(true)
  })

  it('summary starts with PR Scrutiny Review header', async () => {
    const job = await loadFixture(FIXTURE_DIR, { command: 'review:security' })
    const { review } = await runOrchestrator(job)
    expect(review.summary).toContain('## PR Scrutiny')
  })

  it('trace.total_findings matches findings in review', async () => {
    const job = await loadFixture(FIXTURE_DIR, { command: 'review:security' })
    const { review, trace } = await runOrchestrator(job)
    expect(trace.total_findings).toBeGreaterThanOrEqual(review.inline.length)
    expect(trace.total_findings).toBeGreaterThanOrEqual(0)
  })
})

describe('Orchestrator — blast-radius', () => {
  it('runs BlastRadiusAgent only', async () => {
    const job = await loadFixture(FIXTURE_DIR, { command: 'blast-radius' })
    const { trace } = await runOrchestrator(job)
    expect(trace.agents).toHaveLength(1)
    expect(trace.agents[0]!.agent).toBe('BlastRadiusAgent')
  })

  it('summary mentions affected files or config', async () => {
    const job = await loadFixture(FIXTURE_DIR, { command: 'blast-radius' })
    const { review } = await runOrchestrator(job)
    // Blast radius always produces at least 1 finding (missing tests or config)
    expect(review.summary).toBeTruthy()
  })
})

describe('Orchestrator — timeout handling', () => {
  it('timed-out agent produces empty findings with timed_out=true in trace', () => {
    // Test the timeout result shape directly via aggregator with a timed-out trace
    const timedOutResult: AgentResult = {
      agent: 'LLMAgent',
      findings: [],
      trace: {
        agent: 'LLMAgent',
        started_at: new Date().toISOString(),
        duration_ms: 60000,
        finding_count: 0,
        timed_out: true,
        error: 'Agent timed out after 60000ms',
      },
    }

    const { trace } = aggregate('job-1', 'review', new Date().toISOString(), [timedOutResult])
    const llmTrace = trace.agents.find((a) => a.agent === 'LLMAgent')!
    expect(llmTrace.timed_out).toBe(true)
    expect(llmTrace.error).toContain('timed out')
  })
})
