import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { loadFixture } from '../../src/fixtures/loader.js'
import { runQualityAgent } from '../../src/agents/quality/index.js'
import { scanLogic } from '../../src/agents/quality/logic.js'
import { scanComplexity } from '../../src/agents/quality/complexity.js'
import { scanTestCoverage } from '../../src/agents/quality/test-coverage.js'
import { scanPerformance } from '../../src/agents/quality/performance.js'
import type { ReviewJob } from '../../src/types/index.js'

const FIXTURE_DIR = resolve('tests/fixtures-data/pr-001-hardcoded-secret')

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeCleanJob(): ReviewJob {
  return {
    job_id: 'test-clean',
    command: 'review',
    diff: [{ path: 'src/clean.ts', additions: 5, deletions: 0, patch: '+export function greet(name: string) {\n+  return `Hello, ${name}`\n+}' }],
    pr: { number: 1, title: 'Clean PR', description: '', commit_messages: [], base_branch: 'main', head_sha: 'abc', repo: 'a/b' },
    changed_files: [{
      path: 'src/clean.ts',
      content: `export function greet(name: string) {\n  return \`Hello, \${name}\`\n}\n`,
    }],
    related_files: [],
    repo_tree: ['tests/clean.test.ts'],
    llm_api_key: '',
    llm_provider: 'anthropic',
    llm_model: 'claude-sonnet-4-5',
    repo_config: {},
    installation_id: 0,
  }
}

// ─── Pass 1: Logic ─────────────────────────────────────────────────────────────

describe('Pass 1 — Logic reviewer', () => {
  it('flags off-by-one <= length pattern', () => {
    const job = makeCleanJob()
    job.changed_files = [{
      path: 'src/util.ts',
      content: `for (let i = 0; i <= arr.length; i++) {\n  console.log(arr[i])\n}\n`,
    }]
    const findings = scanLogic(job)
    expect(findings.some((f) => f.message.includes('off-by-one') || f.message.includes('<= length'))).toBe(true)
  })

  it('flags unreachable code after return', () => {
    const job = makeCleanJob()
    job.changed_files = [{
      path: 'src/util.ts',
      content: `function foo() {\n  return 42\n  console.log('unreachable')\n}\n`,
    }]
    const findings = scanLogic(job)
    expect(findings.some((f) => f.message.includes('Unreachable'))).toBe(true)
  })

  it('flags always-false condition', () => {
    const job = makeCleanJob()
    job.changed_files = [{
      path: 'src/util.ts',
      content: `if (false) {\n  doSomething()\n}\n`,
    }]
    const findings = scanLogic(job)
    expect(findings.some((f) => f.message.includes('always false'))).toBe(true)
  })

  it('clean code produces zero logic findings', () => {
    const job = makeCleanJob()
    const findings = scanLogic(job)
    expect(findings).toHaveLength(0)
  })
})

// ─── Pass 2: Complexity ────────────────────────────────────────────────────────

describe('Pass 2 — Complexity scorer', () => {
  it('finds high-complexity function in fixture (WARN or SUGGEST)', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanComplexity(job)
    const flagged = findings.filter((f) => f.severity === 'WARN' || f.severity === 'SUGGEST')
    expect(flagged.length).toBeGreaterThan(0)
    expect(flagged.some((f) => f.message.includes('processUserBatch') || f.message.includes('score'))).toBe(true)
  })

  it('flagged complexity finding has remediation', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanComplexity(job)
    const flagged = findings.find((f) => f.severity === 'WARN' || f.severity === 'SUGGEST')
    expect(flagged?.remediation).toBeTruthy()
  })

  it('simple function produces no complexity finding', () => {
    const job = makeCleanJob()
    const findings = scanComplexity(job)
    expect(findings.filter((f) => f.severity === 'WARN')).toHaveLength(0)
  })

  it('moderate complexity (11-20) produces SUGGEST', () => {
    const job = makeCleanJob()
    // Build a function with ~12 branches
    const branches = Array.from({ length: 12 }, (_, i) => `  if (x === ${i}) return ${i}`).join('\n')
    job.changed_files = [{ path: 'src/util.ts', content: `function check(x) {\n${branches}\n}\n` }]
    job.diff = [{ path: 'src/util.ts', additions: 14, deletions: 0, patch: '' }]
    const findings = scanComplexity(job)
    expect(findings.some((f) => f.severity === 'SUGGEST' || f.severity === 'WARN')).toBe(true)
  })
})

// ─── Pass 3: Test coverage ─────────────────────────────────────────────────────

describe('Pass 3 — Test coverage gaps', () => {
  it('flags new functions in fixture with no test file (SUGGEST)', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    // repo_tree has tests/routes/users.test.js — but not for db.js
    const findings = scanTestCoverage(job)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every((f) => f.severity === 'SUGGEST')).toBe(true)
  })

  it('no finding when test file exists for changed file', () => {
    const job = makeCleanJob()
    // repo_tree already has tests/clean.test.ts
    const findings = scanTestCoverage(job)
    expect(findings).toHaveLength(0)
  })

  it('skips test files themselves', () => {
    const job = makeCleanJob()
    job.diff = [{ path: 'src/util.test.ts', additions: 5, deletions: 0, patch: '+it("works", () => {})' }]
    job.changed_files = [{ path: 'src/util.test.ts', content: 'it("works", () => {})' }]
    const findings = scanTestCoverage(job)
    expect(findings).toHaveLength(0)
  })
})

// ─── Pass 4: Performance ───────────────────────────────────────────────────────

describe('Pass 4 — Performance flagger', () => {
  it('finds N+1 pattern in fixture searchUsers (WARN)', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanPerformance(job)
    const n1 = findings.filter((f) => f.message.includes('N+1'))
    expect(n1.length).toBeGreaterThan(0)
    expect(n1[0]!.severity).toBe('WARN')
  })

  it('N+1 finding points to db.js', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanPerformance(job)
    const n1 = findings.filter((f) => f.message.includes('N+1'))
    expect(n1.some((f) => f.file?.includes('db.js'))).toBe(true)
  })

  it('flags readFileSync in async function', () => {
    const job = makeCleanJob()
    job.changed_files = [{
      path: 'src/loader.ts',
      content: `async function loadConfig() {\n  const data = readFileSync('./config.json')\n  return JSON.parse(data)\n}\n`,
    }]
    const findings = scanPerformance(job)
    expect(findings.some((f) => f.message.includes('readFileSync'))).toBe(true)
  })

  it('clean code with no loops or blocking IO has no perf findings', () => {
    const job = makeCleanJob()
    const findings = scanPerformance(job)
    expect(findings).toHaveLength(0)
  })

  it('flags while(true) with no break', () => {
    const job = makeCleanJob()
    job.changed_files = [{
      path: 'src/loop.ts',
      content: `function spin() {\n  while (true) {\n    doWork()\n  }\n}\n`,
    }]
    const findings = scanPerformance(job)
    expect(findings.some((f) => f.message.includes('infinite loop') || f.message.includes('while(true)'))).toBe(true)
  })
})

// ─── Full agent ────────────────────────────────────────────────────────────────

describe('QualityAgent — full run', () => {
  it('returns valid AgentResult shape', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runQualityAgent(job)
    expect(result.agent).toBe('QualityAgent')
    expect(Array.isArray(result.findings)).toBe(true)
    expect(result.trace).toMatchObject({
      agent: 'QualityAgent',
      started_at: expect.any(String),
      duration_ms: expect.any(Number),
      finding_count: expect.any(Number),
      timed_out: false,
    })
    expect(result.trace.finding_count).toBe(result.findings.length)
  })

  it('finds issues across multiple passes on fixture', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runQualityAgent(job)
    const meta = result.metadata as { pass_counts: Record<string, number> }
    // complexity and perf should both fire
    expect(meta.pass_counts.complexity + meta.pass_counts.performance).toBeGreaterThan(0)
  })

  it('review:perf only runs performance pass', async () => {
    const job = await loadFixture(FIXTURE_DIR, { command: 'review:perf' })
    const result = await runQualityAgent(job)
    const meta = result.metadata as { perf_only: boolean; pass_counts: Record<string, number> }
    expect(meta.perf_only).toBe(true)
    expect(meta.pass_counts.logic).toBe(0)
    expect(meta.pass_counts.complexity).toBe(0)
    expect(meta.pass_counts.coverage).toBe(0)
    // perf may or may not find something, but the other passes must be zero
  })

  it('all findings have severity + message', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runQualityAgent(job)
    for (const f of result.findings) {
      expect(f.severity).toMatch(/^(HOLD|WARN|SUGGEST|PASS|QUESTION)$/)
      expect(f.message).toBeTruthy()
    }
  })
})
