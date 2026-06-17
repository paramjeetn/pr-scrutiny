import type { ReviewJob, JobTrace } from '../types/index.js'
import { getAgentsForCommand } from './router.js'
import { dispatch } from './dispatcher.js'
import { aggregate } from './aggregator.js'
import { format } from './formatter.js'
import type { FormattedReview } from './formatter.js'

export interface OrchestratorResult {
  review: FormattedReview
  trace: JobTrace
}

export async function runOrchestrator(job: ReviewJob): Promise<OrchestratorResult> {
  const started_at = new Date().toISOString()
  const agents = getAgentsForCommand(job.command)

  const results = await dispatch(agents, job)
  const aggregated = aggregate(job.job_id, job.command, started_at, results)
  const review = format(aggregated)

  return { review, trace: aggregated.trace }
}
