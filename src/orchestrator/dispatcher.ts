import type { ReviewJob, AgentResult, AgentTrace } from '../types/index.js'
import type { AgentName } from './router.js'
import { runSecurityAgent } from '../agents/security/index.js'
import { runQualityAgent } from '../agents/quality/index.js'
import { runLLMAgent } from '../agents/llm/index.js'
import { runBlastRadiusAgent } from '../agents/blast-radius/index.js'

// Per-agent timeouts (ms)
const AGENT_TIMEOUTS: Record<AgentName, number> = {
  SecurityAgent:    30_000,
  QualityAgent:     30_000,
  LLMAgent:         60_000,
  BlastRadiusAgent: 30_000,
}

function timeoutResult(agent: AgentName, started_at: string, startMs: number): AgentResult {
  const trace: AgentTrace = {
    agent,
    started_at,
    duration_ms: Date.now() - startMs,
    finding_count: 0,
    timed_out: true,
    error: `Agent timed out after ${AGENT_TIMEOUTS[agent]}ms`,
  }
  return { agent, findings: [], trace }
}

async function runWithTimeout(
  agent: AgentName,
  job: ReviewJob
): Promise<AgentResult> {
  const started_at = new Date().toISOString()
  const startMs = Date.now()
  const timeout = AGENT_TIMEOUTS[agent]

  const timeoutPromise = new Promise<AgentResult>((resolve) =>
    setTimeout(() => resolve(timeoutResult(agent, started_at, startMs)), timeout)
  )

  const runPromise: Promise<AgentResult> = (() => {
    switch (agent) {
      case 'SecurityAgent':    return runSecurityAgent(job)
      case 'QualityAgent':     return runQualityAgent(job)
      case 'LLMAgent':         return runLLMAgent(job)
      case 'BlastRadiusAgent': return runBlastRadiusAgent(job)
    }
  })()

  return Promise.race([runPromise, timeoutPromise])
}

export async function dispatch(
  agents: AgentName[],
  job: ReviewJob
): Promise<AgentResult[]> {
  const settled = await Promise.allSettled(
    agents.map((agent) => runWithTimeout(agent, job))
  )

  return settled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value

    // Unexpected rejection (runWithTimeout should never reject — defensive)
    const agent = agents[i]!
    const trace: AgentTrace = {
      agent,
      started_at: new Date().toISOString(),
      duration_ms: 0,
      finding_count: 0,
      timed_out: false,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    }
    return { agent, findings: [], trace }
  })
}
