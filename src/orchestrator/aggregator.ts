import type { AgentResult, Finding, JobTrace, Command } from '../types/index.js'
import { SEVERITY_ORDER } from '../types/index.js'

export interface AggregatedResult {
  findings: Finding[]
  trace: JobTrace
}

// Dedup key: findings with same file+line get merged (highest severity wins)
// Findings without file/line are kept as-is (top-level)
function dedup(findings: Finding[]): Finding[] {
  const keyed = new Map<string, Finding>()
  const unkeyed: Finding[] = []

  for (const f of findings) {
    if (f.file && f.line !== undefined) {
      const key = `${f.file}:${f.line}`
      const existing = keyed.get(key)
      if (!existing || SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[existing.severity]) {
        keyed.set(key, f)
      }
    } else {
      unkeyed.push(f)
    }
  }

  return [...keyed.values(), ...unkeyed]
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  )
}

export function aggregate(
  job_id: string,
  command: Command,
  started_at: string,
  results: AgentResult[]
): AggregatedResult {
  const allFindings = results.flatMap((r) => r.findings)
  const deduplicated = dedup(allFindings)
  const sorted = sortFindings(deduplicated)

  const llmTokens = results
    .find((r) => r.agent === 'LLMAgent')
    ?.metadata?.tokens_used as number | undefined

  const trace: JobTrace = {
    job_id,
    command,
    started_at,
    duration_ms: Date.now() - new Date(started_at).getTime(),
    agents: results.map((r) => r.trace),
    total_findings: sorted.length,
    ...(llmTokens !== undefined ? { llm_tokens_used: llmTokens } : {}),
  }

  return { findings: sorted, trace }
}
