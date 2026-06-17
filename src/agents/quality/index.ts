import type { ReviewJob, AgentResult, AgentTrace } from '../../types/index.js'
import { scanLogic } from './logic.js'
import { scanComplexity } from './complexity.js'
import { scanTestCoverage } from './test-coverage.js'
import { scanPerformance } from './performance.js'

export async function runQualityAgent(job: ReviewJob): Promise<AgentResult> {
  const started_at = new Date().toISOString()
  const startMs = Date.now()

  // Determine which passes to run based on command
  const perfOnly = job.command === 'review:perf'

  const [logicFindings, complexityFindings, coverageFindings, perfFindings] =
    await Promise.all([
      Promise.resolve(perfOnly ? [] : scanLogic(job)),
      Promise.resolve(perfOnly ? [] : scanComplexity(job)),
      Promise.resolve(perfOnly ? [] : scanTestCoverage(job)),
      Promise.resolve(scanPerformance(job)),
    ])

  const findings = [
    ...logicFindings,
    ...complexityFindings,
    ...coverageFindings,
    ...perfFindings,
  ]

  const trace: AgentTrace = {
    agent: 'QualityAgent',
    started_at,
    duration_ms: Date.now() - startMs,
    finding_count: findings.length,
    timed_out: false,
  }

  return {
    agent: 'QualityAgent',
    findings,
    trace,
    metadata: {
      perf_only: perfOnly,
      pass_counts: {
        logic: logicFindings.length,
        complexity: complexityFindings.length,
        coverage: coverageFindings.length,
        performance: perfFindings.length,
      },
    },
  }
}
