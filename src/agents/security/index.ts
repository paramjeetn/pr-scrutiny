import type { ReviewJob, AgentResult, AgentTrace } from '../../types/index.js'
import { scanSecrets } from './secrets.js'
import { scanInjection } from './injection.js'
import { scanDependencies, type OsvFetcher } from './dependencies.js'
import { scanAuth } from './auth.js'

export interface SecurityAgentOptions {
  osvFetcher?: OsvFetcher
}

export async function runSecurityAgent(
  job: ReviewJob,
  options: SecurityAgentOptions = {}
): Promise<AgentResult> {
  const started_at = new Date().toISOString()
  const startMs = Date.now()

  // Run all 4 passes in parallel
  const [secretFindings, injectionFindings, depFindings, authFindings] =
    await Promise.all([
      Promise.resolve(scanSecrets(job)),
      Promise.resolve(scanInjection(job)),
      scanDependencies(job, options.osvFetcher),
      Promise.resolve(scanAuth(job)),
    ])

  const findings = [
    ...secretFindings,
    ...injectionFindings,
    ...depFindings,
    ...authFindings,
  ]

  const trace: AgentTrace = {
    agent: 'SecurityAgent',
    started_at,
    duration_ms: Date.now() - startMs,
    finding_count: findings.length,
    timed_out: false,
  }

  return {
    agent: 'SecurityAgent',
    findings,
    trace,
    metadata: {
      pass_counts: {
        secrets: secretFindings.length,
        injection: injectionFindings.length,
        dependencies: depFindings.length,
        auth: authFindings.length,
      },
    },
  }
}
