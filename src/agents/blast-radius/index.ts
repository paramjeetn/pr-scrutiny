import type { ReviewJob, AgentResult, AgentTrace, Finding } from '../../types/index.js'
import { buildImportGraph, buildReverseGraph, traverseAffected } from './graph.js'
import { classify } from './classify.js'

const MAX_HOPS = 2

export async function runBlastRadiusAgent(job: ReviewJob): Promise<AgentResult> {
  const started_at = new Date().toISOString()
  const startMs = Date.now()

  const changedPaths = job.diff.map((d) => d.path)

  // Build import graph from all available file contents
  const allFiles = [...job.changed_files, ...job.related_files]
  const graph = buildImportGraph(allFiles, job.repo_tree)
  const reverseGraph = buildReverseGraph(graph)

  // Traverse: who is affected by the changed files?
  const affectedFiles = traverseAffected(changedPaths, reverseGraph, job.repo_tree, MAX_HOPS)

  // Classify the blast radius
  const metadata = classify(changedPaths, affectedFiles, job.repo_tree, MAX_HOPS)

  // Generate findings from classification
  const findings: Finding[] = []

  if (metadata.config_changes) {
    findings.push({
      severity: 'WARN',
      message: `Config/environment changes detected in: ${changedPaths.filter((p) => /config|\.env|settings/i.test(p)).join(', ')}. Verify all environments are updated.`,
      remediation: 'Ensure the change is reflected in all environment configs (dev, staging, prod) and documented.',
    })
  }

  if (metadata.migration_files.length > 0) {
    findings.push({
      severity: 'WARN',
      message: `Database migration file(s) included: ${metadata.migration_files.join(', ')}. Ensure migration is backward-compatible and reversible.`,
      remediation: 'Test the migration on a copy of prod data. Confirm a rollback plan exists.',
    })
  }

  if (metadata.missing_tests.length > 0) {
    findings.push({
      severity: 'SUGGEST',
      message: `${metadata.missing_tests.length} changed file(s) have no corresponding test file: ${metadata.missing_tests.slice(0, 3).join(', ')}${metadata.missing_tests.length > 3 ? ` (+${metadata.missing_tests.length - 3} more)` : ''}`,
      remediation: 'Add tests for changed files to prevent regressions in affected downstream code.',
    })
  }

  if (metadata.affected_routes.length > 0) {
    findings.push({
      severity: 'SUGGEST',
      message: `${metadata.affected_routes.length} route file(s) in blast radius: ${metadata.affected_routes.join(', ')}. Verify API contracts are unchanged.`,
      remediation: 'Run integration tests against affected routes. Check for breaking API changes.',
    })
  }

  const trace: AgentTrace = {
    agent: 'BlastRadiusAgent',
    started_at,
    duration_ms: Date.now() - startMs,
    finding_count: findings.length,
    timed_out: false,
  }

  return {
    agent: 'BlastRadiusAgent',
    findings,
    trace,
    metadata: metadata as unknown as Record<string, unknown>,
  }
}
