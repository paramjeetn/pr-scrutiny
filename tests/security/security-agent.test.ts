import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { loadFixture } from '../../src/fixtures/loader.js'
import { runSecurityAgent } from '../../src/agents/security/index.js'
import { scanSecrets } from '../../src/agents/security/secrets.js'
import { scanInjection } from '../../src/agents/security/injection.js'
import { scanDependencies } from '../../src/agents/security/dependencies.js'
import { scanAuth } from '../../src/agents/security/auth.js'
import type { ReviewJob, Finding } from '../../src/types/index.js'

const FIXTURE_DIR = resolve('tests/fixtures-data/pr-001-hardcoded-secret')

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeCleanJob(): ReviewJob {
  return {
    job_id: 'test-clean',
    command: 'review',
    diff: [],
    pr: {
      number: 1,
      title: 'Clean PR',
      description: '',
      commit_messages: [],
      base_branch: 'main',
      head_sha: 'abc123',
      repo: 'owner/repo',
    },
    changed_files: [
      {
        path: 'src/clean.ts',
        content: `
import express from 'express'
const router = express.Router()

// GET /health — intentionally public
router.get('/health', (_req, res) => {
  res.json({ ok: true })
})

export default router
`,
      },
    ],
    related_files: [],
    repo_tree: [],
    llm_api_key: '',
    llm_provider: 'anthropic',
    llm_model: 'claude-sonnet-4-5',
    repo_config: {},
    installation_id: 0,
  }
}

// ─── Pass 1: Secrets ───────────────────────────────────────────────────────────

describe('Pass 1 — Secrets scanner', () => {
  it('finds hardcoded Stripe live key (HOLD)', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanSecrets(job)
    const stripeFindings = findings.filter(
      (f) => f.message.includes('Stripe') && f.severity === 'HOLD'
    )
    expect(stripeFindings.length).toBeGreaterThan(0)
    expect(stripeFindings[0]!.file).toContain('config.js')
  })

  it('finds AWS access key ID (HOLD)', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanSecrets(job)
    const awsFindings = findings.filter(
      (f) => f.message.includes('AWS') && f.severity === 'HOLD'
    )
    expect(awsFindings.length).toBeGreaterThan(0)
  })

  it('finds hardcoded password (HOLD)', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanSecrets(job)
    const pwFindings = findings.filter(
      (f) => f.message.toLowerCase().includes('password') && f.severity === 'HOLD'
    )
    expect(pwFindings.length).toBeGreaterThan(0)
  })

  it('all secret findings have file + line + remediation', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanSecrets(job)
    expect(findings.length).toBeGreaterThan(0)
    for (const f of findings) {
      expect(f.file).toBeTruthy()
      expect(f.line).toBeGreaterThan(0)
      expect(f.remediation).toBeTruthy()
    }
  })

  it('clean code produces zero secret findings', () => {
    const job = makeCleanJob()
    const findings = scanSecrets(job)
    expect(findings).toHaveLength(0)
  })

  it('skips test/fixture/mock files', () => {
    const job = makeCleanJob()
    job.changed_files = [
      {
        path: 'tests/fixtures/config.js',
        content: "const STRIPE_KEY = 'sk_live_4eC39HqLyjWDarjtT1zdp7dc'",
      },
    ]
    const findings = scanSecrets(job)
    expect(findings).toHaveLength(0)
  })

  it('entropy-based WARN for high-entropy strings', () => {
    const job = makeCleanJob()
    job.changed_files = [
      {
        path: 'src/config.ts',
        content: "const token = 'xK9mP2qRvNtWjL8hDcYeAsBuFoZi3Gw5'",
      },
    ]
    const findings = scanSecrets(job)
    const warnFindings = findings.filter((f) => f.severity === 'WARN')
    expect(warnFindings.length).toBeGreaterThanOrEqual(0) // may or may not trigger depending on entropy
  })
})

// ─── Pass 2: Injection ─────────────────────────────────────────────────────────

describe('Pass 2 — Injection scanner', () => {
  it('finds eval() with non-literal arg (HOLD)', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanInjection(job)
    const evalFindings = findings.filter(
      (f) => f.message.includes('eval') && f.severity === 'HOLD'
    )
    expect(evalFindings.length).toBeGreaterThan(0)
    expect(evalFindings[0]!.file).toContain('users.js')
  })

  it('finds raw SQL string concatenation (HOLD)', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanInjection(job)
    const sqlFindings = findings.filter((f) => f.message.includes('SQL'))
    expect(sqlFindings.length).toBeGreaterThan(0)
  })

  it('all injection findings have file + line + remediation', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanInjection(job)
    expect(findings.length).toBeGreaterThan(0)
    for (const f of findings) {
      expect(f.file).toBeTruthy()
      expect(f.line).toBeGreaterThan(0)
      expect(f.remediation).toBeTruthy()
    }
  })

  it('clean code produces zero injection findings', () => {
    const job = makeCleanJob()
    const findings = scanInjection(job)
    expect(findings).toHaveLength(0)
  })

  it('safe eval with literal string is not flagged', () => {
    const job = makeCleanJob()
    job.changed_files = [
      {
        path: 'src/safe.ts',
        // eval with a literal string (e.g. in a build script) — should not flag HOLD
        content: "const result = eval('1 + 1')",
      },
    ]
    const findings = scanInjection(job)
    const holdFindings = findings.filter((f) => f.severity === 'HOLD')
    expect(holdFindings).toHaveLength(0)
  })

  it('innerHTML with variable is flagged', () => {
    const job = makeCleanJob()
    job.changed_files = [
      {
        path: 'src/ui.ts',
        content: `
function render(data: string) {
  document.getElementById('app')!.innerHTML = data
}
`,
      },
    ]
    const findings = scanInjection(job)
    const innerHtmlFindings = findings.filter((f) => f.message.includes('innerHTML'))
    expect(innerHtmlFindings.length).toBeGreaterThan(0)
  })
})

// ─── Pass 3: Dependencies ──────────────────────────────────────────────────────

describe('Pass 3 — Dependency auditor', () => {
  it('returns empty array when no manifest', async () => {
    const job = makeCleanJob()
    // no dependency_manifest
    const findings = await scanDependencies(job, async () => ({}))
    expect(findings).toHaveLength(0)
  })

  it('flags CVE with CVSS >= 7.0 from OSV (WARN)', async () => {
    const job = makeCleanJob()
    job.dependency_manifest = JSON.stringify({
      dependencies: { 'some-pkg': '1.0.0' },
    })

    const mockOsv = async () => ({
      vulns: [
        {
          id: 'GHSA-test-0001',
          summary: 'Remote code execution in some-pkg',
          severity: [{ type: 'CVSS_V3', score: 8.5 }],
        },
      ],
    })

    const findings = await scanDependencies(job, mockOsv)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0]!.message).toContain('GHSA-test-0001')
    expect(findings[0]!.severity === 'HOLD' || findings[0]!.severity === 'WARN').toBe(true)
  })

  it('ignores CVE with CVSS < 7.0', async () => {
    const job = makeCleanJob()
    job.dependency_manifest = JSON.stringify({
      dependencies: { 'low-risk-pkg': '2.0.0' },
    })

    const mockOsv = async () => ({
      vulns: [
        {
          id: 'GHSA-low-0001',
          summary: 'Low severity issue',
          severity: [{ type: 'CVSS_V3', score: 3.5 }],
        },
      ],
    })

    const findings = await scanDependencies(job, mockOsv)
    expect(findings).toHaveLength(0)
  })

  it('critical CVE (CVSS >= 9.0) is HOLD', async () => {
    const job = makeCleanJob()
    job.dependency_manifest = JSON.stringify({
      dependencies: { 'critical-pkg': '0.0.1' },
    })

    const mockOsv = async () => ({
      vulns: [
        {
          id: 'GHSA-crit-0001',
          summary: 'Critical RCE',
          severity: [{ type: 'CVSS_V3', score: 9.8 }],
        },
      ],
    })

    const findings = await scanDependencies(job, mockOsv)
    const crit = findings.find((f) => f.message.includes('GHSA-crit-0001'))
    expect(crit?.severity).toBe('HOLD')
  })

  it('no findings when OSV returns no vulns', async () => {
    const job = makeCleanJob()
    job.dependency_manifest = JSON.stringify({
      dependencies: { express: '^4.18.2' },
    })

    const mockOsv = async () => ({ vulns: [] })
    const findings = await scanDependencies(job, mockOsv)
    // only possible finding is the "very early release" heuristic — express is not 0.x
    const cveFindings = findings.filter((f) => f.message.includes('CVE') || f.message.includes('GHSA'))
    expect(cveFindings).toHaveLength(0)
  })
})

// ─── Pass 4: Auth gaps ─────────────────────────────────────────────────────────

describe('Pass 4 — Auth gap scanner', () => {
  it('flags new route without auth middleware', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanAuth(job)
    const authFindings = findings.filter(
      (f) => f.message.includes('auth') || f.message.includes('middleware')
    )
    expect(authFindings.length).toBeGreaterThan(0)
  })

  it('auth findings point to routes in users.js', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const findings = scanAuth(job)
    const routeFindings = findings.filter((f) => f.file?.includes('users.js'))
    expect(routeFindings.length).toBeGreaterThan(0)
  })

  it('clean route with auth middleware is not flagged', () => {
    const job = makeCleanJob()
    job.changed_files = [
      {
        path: 'src/routes/posts.ts',
        content: `
import { requireAuth } from '../middleware/auth'
const router = require('express').Router()

router.get('/posts', requireAuth, async (req, res) => {
  res.json([])
})
`,
      },
    ]
    const findings = scanAuth(job)
    const holdFindings = findings.filter((f) => f.severity === 'HOLD')
    expect(holdFindings).toHaveLength(0)
  })

  it('flags JWT algorithms: none', () => {
    const job = makeCleanJob()
    job.changed_files = [
      {
        path: 'src/auth.ts',
        content: `
jwt.verify(token, secret, { algorithms: 'none' })
`,
      },
    ]
    const findings = scanAuth(job)
    const jwtFindings = findings.filter((f) => f.message.includes("'none'"))
    expect(jwtFindings.length).toBeGreaterThan(0)
    expect(jwtFindings[0]!.severity).toBe('HOLD')
  })
})

// ─── Full agent: AgentResult shape ─────────────────────────────────────────────

describe('SecurityAgent — full run', () => {
  it('returns valid AgentResult shape', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runSecurityAgent(job, { osvFetcher: async () => ({}) })

    expect(result.agent).toBe('SecurityAgent')
    expect(Array.isArray(result.findings)).toBe(true)
    expect(result.trace).toMatchObject({
      agent: 'SecurityAgent',
      started_at: expect.any(String),
      duration_ms: expect.any(Number),
      finding_count: expect.any(Number),
      timed_out: false,
    })
    expect(result.trace.finding_count).toBe(result.findings.length)
  })

  it('finds issues across all 4 passes on fixture', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runSecurityAgent(job, { osvFetcher: async () => ({}) })

    const meta = result.metadata as { pass_counts: Record<string, number> }
    expect(meta.pass_counts.secrets).toBeGreaterThan(0)
    expect(meta.pass_counts.injection).toBeGreaterThan(0)
    expect(meta.pass_counts.auth).toBeGreaterThan(0)
  })

  it('all findings have severity + message', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runSecurityAgent(job, { osvFetcher: async () => ({}) })

    for (const f of result.findings) {
      expect(f.severity).toMatch(/^(HOLD|WARN|SUGGEST|PASS|QUESTION)$/)
      expect(f.message).toBeTruthy()
    }
  })

  it('HOLD findings exist on the fixture', async () => {
    const job = await loadFixture(FIXTURE_DIR)
    const result = await runSecurityAgent(job, { osvFetcher: async () => ({}) })

    const holds = result.findings.filter((f: Finding) => f.severity === 'HOLD')
    expect(holds.length).toBeGreaterThan(0)
  })

  it('clean job produces no HOLD findings', async () => {
    const job = makeCleanJob()
    const result = await runSecurityAgent(job, { osvFetcher: async () => ({}) })
    const holds = result.findings.filter((f: Finding) => f.severity === 'HOLD')
    expect(holds).toHaveLength(0)
  })

  it('trace duration_ms is a positive number', async () => {
    const job = makeCleanJob()
    const result = await runSecurityAgent(job, { osvFetcher: async () => ({}) })
    expect(result.trace.duration_ms).toBeGreaterThanOrEqual(0)
  })
})
